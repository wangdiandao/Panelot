import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MANIFEST_VERSION = 1;
const PROTOCOL_FILE = 'src/messaging/protocol.ts';
const HASH_PATTERNS = {
  engine: /(export const ENGINE_SCHEMA_HASH\s*=\s*['"])([a-f\d]{64})(['"]\s+as const;)/u,
  content: /(export const CONTENT_SCRIPT_SCHEMA_HASH\s*=\s*['"])([a-f\d]{64})(['"]\s+as const;)/u,
};

const PROTOCOLS = {
  engine: {
    hashName: 'ENGINE_SCHEMA_HASH',
    roots: ['Op', 'AgentEvent', 'ENGINE_PROTOCOL', 'PROTOCOL_VERSION'],
    runtimeRoots: [
      'OP_TYPE_CATALOG',
      'AGENT_EVENT_TYPE_CATALOG',
      'ITEM_KIND_CATALOG',
      'TURN_KIND_CATALOG',
      'STOP_REASON_CATALOG',
      'ERROR_CODE_CATALOG',
      'PROVIDER_ERROR_KIND_CATALOG',
      'isKnownAgentEventType',
      'isOp',
    ],
    validators: [
      ['src/messaging/validation.ts', 'parseOp'],
      ['src/messaging/agentEventValidation.ts', 'parseAgentEvent'],
      ['src/messaging/transport.ts', 'decodeAgentEvent'],
    ],
    boundaries: [],
  },
  content: {
    hashName: 'CONTENT_SCRIPT_SCHEMA_HASH',
    roots: ['ContentScriptOp', 'ContentScriptResult', 'CONTENT_SCRIPT_PROTOCOL'],
    runtimeRoots: [],
    validators: [
      ['src/messaging/validation.ts', 'parseContentScriptOp'],
      ['src/messaging/validation.ts', 'parseContentScriptResult'],
      ['src/tools/content/protocol.ts', 'parseContentToolCall'],
      ['src/tools/content/protocol.ts', 'validateExecuteResult'],
      ['src/tools/content/protocol.ts', 'validateActionFailure'],
    ],
    boundaries: [
      {
        file: 'src/tools/gateway.ts',
        className: 'BrowserToolGateway',
        methods: ['#sendContentRequest', '#sendToTabRaw', '#ensureInjected'],
      },
      { file: 'entrypoints/page-executor.unlisted.ts', defaultExport: true },
    ],
  },
};

function parseArguments(argv) {
  let root = process.cwd();
  let write = false;
  let printManifest = false;
  let printHash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      root = resolve(value);
      index += 1;
    } else if (argument === '--write') {
      write = true;
    } else if (argument === '--print-manifest') {
      printManifest = true;
    } else if (argument === '--print-hash') {
      printHash = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { root, write, printManifest, printHash };
}

function sourcePathIfWithin(root, fileName) {
  const path = relative(root, fileName).split(sep).join('/');
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return undefined;
  return path;
}

function sourcePath(root, fileName) {
  const path = sourcePathIfWithin(root, fileName);
  if (!path) throw new Error(`Protocol declaration escaped repository root: ${fileName}`);
  return path;
}

function topLevelStatement(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

function declarationName(node, sourceFile) {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) => declaration.name.getText(sourceFile))
      .join(',');
  }
  return undefined;
}

function printNode(node, sourceFile) {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
    omitTrailingSemicolon: false,
  });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
}

function namedTopLevelStatements(sourceFile) {
  const statements = new Map();
  for (const statement of sourceFile.statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement)
    ) {
      if (statement.name) statements.set(statement.name.text, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) statements.set(declaration.name.text, statement);
      }
    }
  }
  return statements;
}

function resolveSymbol(checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function isManifestSourcePath(path) {
  return path.startsWith('src/') || path.startsWith('entrypoints/');
}

function isManifestDeclaration(statement) {
  return (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isExportAssignment(statement)
  );
}

/**
 * Follow both type and value symbols through repository-owned modules. This is
 * deliberately TypeChecker-backed: an imported validator helper is part of the
 * wire contract just as much as a helper declared beside the parser.
 */
function repositoryDeclarationClosure(
  root,
  program,
  roots,
  excludedStatements = new Set(),
  seedOnlyStatements = new Set(),
) {
  const checker = program.getTypeChecker();
  const pending = [...roots];
  const selected = [];
  const visited = new Set();

  while (pending.length > 0) {
    const statement = pending.pop();
    if (!statement || visited.has(statement) || excludedStatements.has(statement)) continue;
    visited.add(statement);
    const sourceFile = statement.getSourceFile();
    const name = declarationName(statement, sourceFile) ?? '(anonymous)';
    if (name === 'ENGINE_SCHEMA_HASH' || name === 'CONTENT_SCRIPT_SCHEMA_HASH') continue;
    const id = `${sourcePath(root, sourceFile.fileName)}#${name}`;
    if (!seedOnlyStatements.has(statement)) {
      selected.push({ id, source: printNode(statement, sourceFile) });
    }

    const visit = (node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const symbol = resolveSymbol(checker, node);
        for (const declaration of symbol?.declarations ?? []) {
          const dependencySource = declaration.getSourceFile();
          const dependencyPath = sourcePathIfWithin(root, dependencySource.fileName);
          if (!dependencyPath || !isManifestSourcePath(dependencyPath)) continue;
          const dependency = topLevelStatement(declaration);
          if (isManifestDeclaration(dependency) && !excludedStatements.has(dependency)) {
            pending.push(dependency);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }

  return selected.sort(
    (left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source),
  );
}

function namedRepositoryDeclarationClosure(root, program, file, rootName) {
  const path = resolve(root, file);
  const sourceFile = program.getSourceFile(path);
  if (!sourceFile) throw new Error(`Manifest source not found: ${path}`);
  const statement = namedTopLevelStatements(sourceFile).get(rootName);
  if (!statement) throw new Error(`Manifest root ${rootName} not found in ${sourceFile.fileName}`);
  return repositoryDeclarationClosure(root, program, [statement]);
}

function protocolDeclarationClosure(root, program, rootNames) {
  const protocolPath = resolve(root, PROTOCOL_FILE);
  const protocolSource = program.getSourceFile(protocolPath);
  if (!protocolSource) throw new Error(`Protocol source not found: ${protocolPath}`);
  const statements = namedTopLevelStatements(protocolSource);
  const roots = rootNames.map((name) => {
    const statement = statements.get(name);
    if (!statement) throw new Error(`Protocol manifest root not found: ${name}`);
    return statement;
  });
  return repositoryDeclarationClosure(root, program, roots);
}

function memberName(member, sourceFile) {
  return member.name?.getText(sourceFile);
}

function classMemberClosure(classDeclaration, sourceFile, rootNames) {
  const membersByName = new Map(
    classDeclaration.members
      .map((member) => [memberName(member, sourceFile), member])
      .filter(([name]) => name !== undefined),
  );
  const pending = rootNames.map((name) => {
    const member = membersByName.get(name);
    if (!member) {
      throw new Error(
        `Boundary method ${classDeclaration.name?.text ?? '(anonymous)'}.${name} not found in ${sourceFile.fileName}`,
      );
    }
    return member;
  });
  const selected = new Set();

  while (pending.length > 0) {
    const member = pending.pop();
    if (!member || selected.has(member)) continue;
    selected.add(member);
    const visit = (node) => {
      if (ts.isPrivateIdentifier(node) || ts.isIdentifier(node)) {
        const dependency = membersByName.get(node.getText(sourceFile));
        if (dependency && !selected.has(dependency)) pending.push(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(member);
  }

  return [...selected]
    .map((member) => ({
      name: `${classDeclaration.name?.text ?? '(anonymous)'}.${memberName(member, sourceFile) ?? '(anonymous)'}`,
      source: printNode(member, sourceFile),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function boundaryDeclarations(root, program, definition) {
  const path = resolve(root, definition.file);
  const sourceFile = program.getSourceFile(path);
  if (!sourceFile) throw new Error(`Boundary source not found: ${path}`);
  if (definition.defaultExport) {
    const statement = sourceFile.statements.find(
      (candidate) =>
        ts.isExportAssignment(candidate) ||
        candidate.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
    if (!statement) throw new Error(`Default export boundary not found in ${definition.file}`);
    return repositoryDeclarationClosure(root, program, [statement]);
  }

  const classDeclaration = sourceFile.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) && statement.name?.text === definition.className,
  );
  if (!classDeclaration || !ts.isClassDeclaration(classDeclaration)) {
    throw new Error(`Boundary class ${definition.className} not found in ${definition.file}`);
  }
  const members = classMemberClosure(classDeclaration, sourceFile, definition.methods);
  const selectedMemberNames = new Set(members.map(({ name }) => name.split('.').at(-1)));
  const selectedMembers = classDeclaration.members.filter((member) =>
    selectedMemberNames.has(memberName(member, sourceFile)),
  );
  const dependencies = repositoryDeclarationClosure(
    root,
    program,
    selectedMembers,
    new Set([classDeclaration]),
    new Set(selectedMembers),
  );
  return [
    ...members.map(({ name, source }) => ({ id: `${definition.file}#${name}`, source })),
    ...dependencies,
  ].sort((left, right) => (left.id ?? left.name).localeCompare(right.id ?? right.name));
}

function buildManifest(root, program, name, definition) {
  const protocolDeclarations = protocolDeclarationClosure(root, program, [
    ...definition.roots,
    ...definition.runtimeRoots,
  ]);
  const validators = definition.validators.map(([file, rootName]) => {
    return {
      id: `${file}#${rootName}`,
      declarations: namedRepositoryDeclarationClosure(root, program, file, rootName),
    };
  });
  const boundaries = definition.boundaries.map((boundary) => ({
    id: boundary.file,
    declarations: boundaryDeclarations(root, program, boundary),
  }));
  return {
    manifestVersion: MANIFEST_VERSION,
    protocol: name,
    roots: definition.roots,
    protocolDeclarations,
    validators,
    boundaries,
  };
}

export async function buildProtocolManifests(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const rootNames = [
    PROTOCOL_FILE,
    ...Object.values(PROTOCOLS).flatMap((definition) => [
      ...definition.validators.map(([file]) => file),
      ...definition.boundaries.map(({ file }) => file),
    ]),
  ].map((file) => resolve(root, file));
  const program = ts.createProgram([...new Set(rootNames)], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  return Object.fromEntries(
    Object.entries(PROTOCOLS).map(([name, definition]) => [
      name,
      buildManifest(root, program, name, definition),
    ]),
  );
}

export function protocolManifestHash(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function currentSchemaHashes(root) {
  const path = resolve(root, PROTOCOL_FILE);
  const source = await readFile(path, 'utf8');
  const hashes = {};
  for (const [name, definition] of Object.entries(PROTOCOLS)) {
    const match = HASH_PATTERNS[name].exec(source);
    if (!match) {
      throw new Error(`${definition.hashName} constant was not found or is not a SHA-256 hex`);
    }
    hashes[name] = match[2];
  }
  return { hashes, path, source };
}

export async function checkProtocolManifests(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const manifests = await buildProtocolManifests(root);
  const expected = Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [name, protocolManifestHash(manifest)]),
  );
  const current = await currentSchemaHashes(root);
  return { manifests, expected, current };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await checkProtocolManifests(options.root);
  if (options.printManifest) console.log(JSON.stringify(result.manifests, null, 2));
  if (options.printHash) {
    for (const [name, hash] of Object.entries(result.expected)) console.log(`${name} ${hash}`);
  }

  const mismatches = Object.keys(PROTOCOLS).filter(
    (name) => result.current.hashes[name] !== result.expected[name],
  );
  if (options.write && mismatches.length > 0) {
    let updated = result.current.source;
    for (const name of mismatches) {
      updated = updated.replace(HASH_PATTERNS[name], `$1${result.expected[name]}$3`);
      console.log(
        `UPDATED ${PROTOCOLS[name].hashName} ${result.current.hashes[name]} -> ${result.expected[name]}`,
      );
    }
    await writeFile(result.current.path, updated, 'utf8');
    return;
  }
  if (mismatches.length > 0) {
    for (const name of mismatches) {
      console.error(
        `FAIL ${name} protocol manifest: ${PROTOCOLS[name].hashName} is ${result.current.hashes[name]}, expected ${result.expected[name]}`,
      );
    }
    console.error('Run `pnpm protocol:write` after reviewing the manifest diff.');
    process.exitCode = 1;
    return;
  }
  if (!options.printManifest && !options.printHash) {
    for (const [name, hash] of Object.entries(result.expected)) {
      console.log(`PASS ${name} protocol manifest: ${hash}`);
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
