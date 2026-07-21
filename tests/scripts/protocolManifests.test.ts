import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProtocolManifests,
  protocolManifestHash,
} from '../../scripts/check-protocol-manifests.mjs';

const temporaryDirectories: string[] = [];
const MANIFEST_TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}, MANIFEST_TEST_TIMEOUT_MS);

async function writeFixtureFile(root: string, path: string, source: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panelot-protocol-manifest-'));
  temporaryDirectories.push(root);
  await Promise.all([
    writeFixtureFile(
      root,
      'src/messaging/protocol.ts',
      `
        export const PROTOCOL_VERSION = 1;
        export const ENGINE_PROTOCOL = 'engine';
        export const ENGINE_SCHEMA_HASH = '${'0'.repeat(64)}' as const;
        export const CONTENT_SCRIPT_PROTOCOL = 'content';
        export const CONTENT_SCRIPT_SCHEMA_HASH = '${'0'.repeat(64)}' as const;
        type EngineNested = { value: string };
        type ContentNested = { value: string };
        export type Op = { type: 'ping'; submissionId: string; payload: EngineNested };
        export type AgentEvent = { type: 'pong'; payload: EngineNested };
        export type ContentScriptOp = { kind: 'execute'; payload: ContentNested };
        export type ContentScriptResult = { ok: true; result: ContentNested };
        export const OP_TYPE_CATALOG = { ping: true };
        export const AGENT_EVENT_TYPE_CATALOG = { pong: true };
        export const ITEM_KIND_CATALOG = { item: true };
        export const TURN_KIND_CATALOG = { turn: true };
        export const STOP_REASON_CATALOG = { stop: true };
        export const ERROR_CODE_CATALOG = { error: true };
        export const PROVIDER_ERROR_KIND_CATALOG = { provider: true };
        export function isKnownAgentEventType(value: unknown) { return value === 'pong'; }
        export function isOp(value: unknown) { return typeof value === 'object'; }
      `,
    ),
    writeFixtureFile(
      root,
      'src/messaging/validation.ts',
      `
        import { engineImportedHelper, contentImportedHelper } from './resourceLimits';
        function engineHelper(value: unknown) { return value !== null; }
        export function parseOp(value: unknown) {
          return engineHelper(value) && engineImportedHelper(value);
        }
        function contentOpHelper(value: unknown) { return value !== null; }
        export function parseContentScriptOp(value: unknown) {
          return contentOpHelper(value) && contentImportedHelper(value);
        }
        function contentResultHelper(value: unknown) { return value !== undefined; }
        export function parseContentScriptResult(value: unknown) { return contentResultHelper(value); }
      `,
    ),
    writeFixtureFile(
      root,
      'src/messaging/resourceLimits.ts',
      `
        function sharedImportedHelper(value: unknown) { return value !== false; }
        export function engineImportedHelper(value: unknown) {
          return sharedImportedHelper(value) && value !== 'engine-blocked';
        }
        export function contentImportedHelper(value: unknown) {
          return sharedImportedHelper(value) && value !== 'content-blocked';
        }
      `,
    ),
    writeFixtureFile(
      root,
      'src/messaging/agentEventValidation.ts',
      `
        function eventHelper(value: unknown) { return value !== null; }
        export function parseAgentEvent(value: unknown) { return eventHelper(value); }
      `,
    ),
    writeFixtureFile(
      root,
      'src/messaging/transport.ts',
      `
        function decodeHelper(value: unknown) { return value !== null; }
        export function decodeAgentEvent(value: unknown) { return decodeHelper(value); }
      `,
    ),
    writeFixtureFile(
      root,
      'src/tools/content/protocol.ts',
      `
        function toolHelper(value: unknown) { return value !== null; }
        export function parseContentToolCall(value: unknown) { return toolHelper(value); }
        export function validateExecuteResult(value: unknown) { return toolHelper(value); }
        export function validateActionFailure(value: unknown) { return toolHelper(value); }
      `,
    ),
    writeFixtureFile(
      root,
      'src/tools/gateway.ts',
      `
        export class BrowserToolGateway {
          #sendContentRequest() { return this.#sendToTabRaw(); }
          #sendToTabRaw() { return this.#ensureInjected(); }
          #ensureInjected() { return this.#inject(); }
          #inject() { return 'injected'; }
        }
      `,
    ),
    writeFixtureFile(
      root,
      'entrypoints/page-executor.unlisted.ts',
      `
        import { importedPageBoundary } from './page-helper';
        function installListener() { return importedPageBoundary('ready'); }
        export default { main() { return installListener(); } };
      `,
    ),
    writeFixtureFile(
      root,
      'entrypoints/page-helper.ts',
      `
        export function importedPageBoundary(value: string) { return 'page:' + value; }
      `,
    ),
  ]);
  return root;
}

function hashes(manifests: Awaited<ReturnType<typeof buildProtocolManifests>>) {
  return {
    engine: protocolManifestHash(manifests.engine),
    content: protocolManifestHash(manifests.content),
  };
}

describe('protocol manifest generation', () => {
  it(
    'changes the owning manifest for nested declarations and validator helpers',
    async () => {
      const root = await fixture();
      const baseline = hashes(await buildProtocolManifests(root));

      const protocolPath = join(root, 'src/messaging/protocol.ts');
      const protocol = await readFile(protocolPath, 'utf8');
      await writeFile(
        protocolPath,
        protocol.replace(
          'type EngineNested = { value: string }',
          'type EngineNested = { value: number }',
        ),
      );
      const nestedChange = hashes(await buildProtocolManifests(root));
      expect(nestedChange.engine).not.toBe(baseline.engine);
      expect(nestedChange.content).toBe(baseline.content);

      const validationPath = join(root, 'src/messaging/validation.ts');
      const validation = await readFile(validationPath, 'utf8');
      await writeFile(validationPath, validation.replace('value !== null', 'value !== undefined'));
      const helperChange = hashes(await buildProtocolManifests(root));
      expect(helperChange.engine).not.toBe(nestedChange.engine);
      expect(helperChange.content).toBe(nestedChange.content);
    },
    MANIFEST_TEST_TIMEOUT_MS,
  );

  it(
    'covers content types, validators, gateway helper closure, and page executor',
    async () => {
      const root = await fixture();
      const baseline = hashes(await buildProtocolManifests(root));

      const mutations = [
        [
          'src/messaging/protocol.ts',
          'type ContentNested = { value: string }',
          'type ContentNested = { value: number }',
        ],
        ['src/tools/content/protocol.ts', 'return value !== null', 'return value !== undefined'],
        ['src/tools/gateway.ts', "return 'injected'", "return 'reloaded'"],
        [
          'entrypoints/page-executor.unlisted.ts',
          "importedPageBoundary('ready')",
          "importedPageBoundary('listening')",
        ],
        ['entrypoints/page-helper.ts', "return 'page:' + value", "return 'executor:' + value"],
      ] as const;

      for (const [path, before, after] of mutations) {
        const mutationRoot = await fixture();
        const target = join(mutationRoot, path);
        const source = await readFile(target, 'utf8');
        await writeFile(target, source.replace(before, after));
        const changed = hashes(await buildProtocolManifests(mutationRoot));
        expect(changed.content, path).not.toBe(baseline.content);
        expect(changed.engine, path).toBe(baseline.engine);
      }
    },
    MANIFEST_TEST_TIMEOUT_MS,
  );

  it(
    'follows imported helper declarations into only the owning manifest',
    async () => {
      const root = await fixture();
      const baseline = hashes(await buildProtocolManifests(root));
      const helperPath = join(root, 'src/messaging/resourceLimits.ts');
      const source = await readFile(helperPath, 'utf8');

      await writeFile(
        helperPath,
        source.replace("value !== 'engine-blocked'", "value !== 'engine-rejected'"),
      );
      const engineChange = hashes(await buildProtocolManifests(root));
      expect(engineChange.engine).not.toBe(baseline.engine);
      expect(engineChange.content).toBe(baseline.content);

      await writeFile(
        helperPath,
        source.replace("value !== 'content-blocked'", "value !== 'content-rejected'"),
      );
      const contentChange = hashes(await buildProtocolManifests(root));
      expect(contentChange.engine).toBe(baseline.engine);
      expect(contentChange.content).not.toBe(baseline.content);
    },
    MANIFEST_TEST_TIMEOUT_MS,
  );

  it(
    'is stable across comments and formatting-only edits',
    async () => {
      const root = await fixture();
      const baseline = hashes(await buildProtocolManifests(root));
      const protocolPath = join(root, 'src/messaging/protocol.ts');
      const source = await readFile(protocolPath, 'utf8');
      await writeFile(
        protocolPath,
        source
          .replace(
            'type EngineNested = { value: string };',
            '/* format only */ type EngineNested={value:string};',
          )
          .replace(
            "export type AgentEvent = { type: 'pong'; payload: EngineNested };",
            "export type AgentEvent={type:'pong';payload:EngineNested};",
          ),
      );

      expect(hashes(await buildProtocolManifests(root))).toEqual(baseline);
    },
    MANIFEST_TEST_TIMEOUT_MS,
  );
});
