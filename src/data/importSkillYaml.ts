type JsonObject = Record<string, unknown>;

interface YamlLine {
  indent: number;
  raw: string;
  text: string;
}

export function parseImportedSkillRaw(raw: string): {
  frontmatter: JsonObject;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) throw new Error('IMPORT_SKILL_CONTENT');
  if (/(?:^|\s)[&*][a-z0-9_-]+/im.test(match[1]!)) {
    throw new Error('IMPORT_SKILL_CONTENT');
  }
  return {
    frontmatter: new ImportYamlParser(match[1]!).parse(),
    body: (match[2] ?? '').trim(),
  };
}

class ImportYamlParser {
  private index = 0;
  private readonly lines: YamlLine[];

  constructor(source: string) {
    this.lines = source.split(/\r?\n/).map((raw) => {
      if (raw.includes('\t')) throw new Error('IMPORT_SKILL_CONTENT');
      const indent = /^ */.exec(raw)?.[0].length ?? 0;
      return { indent, raw, text: stripComment(raw.slice(indent)).trimEnd() };
    });
  }

  parse(): JsonObject {
    this.skipBlank();
    const first = this.lines[this.index];
    if (!first) throw new Error('IMPORT_SKILL_CONTENT');
    const value = this.parseNode(first.indent);
    this.skipBlank();
    if (this.index !== this.lines.length || !isObject(value)) {
      throw new Error('IMPORT_SKILL_CONTENT');
    }
    return value;
  }

  private parseNode(indent: number): unknown {
    this.skipBlank();
    const line = this.lines[this.index];
    if (!line || line.indent !== indent) throw new Error('IMPORT_SKILL_CONTENT');
    return line.text.startsWith('-') ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  private parseMapping(indent: number, target: JsonObject = {}): JsonObject {
    while (true) {
      this.skipBlank();
      const line = this.lines[this.index];
      if (!line || line.indent < indent) break;
      if (line.indent !== indent || line.text.startsWith('-')) {
        throw new Error('IMPORT_SKILL_CONTENT');
      }
      this.index += 1;
      const [key, rawValue] = splitPair(line.text);
      if (Object.prototype.hasOwnProperty.call(target, key))
        throw new Error('IMPORT_SKILL_CONTENT');
      target[key] = this.parsePairValue(rawValue, indent);
    }
    return target;
  }

  private parseSequence(indent: number): unknown[] {
    const result: unknown[] = [];
    while (true) {
      this.skipBlank();
      const line = this.lines[this.index];
      if (!line || line.indent < indent) break;
      if (line.indent !== indent || !/^-(?:\s|$)/.test(line.text)) {
        throw new Error('IMPORT_SKILL_CONTENT');
      }
      this.index += 1;
      const content = line.text.slice(1).trimStart();
      if (!content) {
        result.push(this.parseNestedOrNull(indent));
        continue;
      }
      const pair = trySplitPair(content);
      if (!pair) {
        result.push(parseScalar(content));
        continue;
      }
      const item: JsonObject = {};
      const itemIndent = indent + 2;
      item[pair[0]] = this.parsePairValue(pair[1], itemIndent);
      this.skipBlank();
      if (this.lines[this.index]?.indent === itemIndent) this.parseMapping(itemIndent, item);
      result.push(item);
    }
    return result;
  }

  private parsePairValue(rawValue: string, parentIndent: number): unknown {
    const value = rawValue.trim();
    if (/^[|>][+-]?$/.test(value)) return this.parseBlockScalar(parentIndent, value[0] === '>');
    if (value) return parseScalar(value);
    return this.parseNestedOrNull(parentIndent);
  }

  private parseNestedOrNull(parentIndent: number): unknown {
    this.skipBlank();
    const next = this.lines[this.index];
    return next && next.indent > parentIndent ? this.parseNode(next.indent) : null;
  }

  private parseBlockScalar(parentIndent: number, folded: boolean): string {
    const start = this.index;
    let end = start;
    let contentIndent = Number.POSITIVE_INFINITY;
    while (end < this.lines.length) {
      const line = this.lines[end]!;
      if (line.raw.trim() && line.indent <= parentIndent) break;
      if (line.raw.trim()) contentIndent = Math.min(contentIndent, line.indent);
      end += 1;
    }
    this.index = end;
    if (!Number.isFinite(contentIndent)) return '';
    const values = this.lines
      .slice(start, end)
      .map((line) => (line.raw.trim() ? line.raw.slice(contentIndent) : ''));
    return folded ? values.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : values.join('\n');
  }

  private skipBlank(): void {
    while (this.index < this.lines.length && !this.lines[this.index]!.text.trim()) {
      this.index += 1;
    }
  }
}

function splitPair(value: string): [string, string] {
  const pair = trySplitPair(value);
  if (!pair) throw new Error('IMPORT_SKILL_CONTENT');
  return pair;
}

function trySplitPair(value: string): [string, string] | null {
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote && (quote === "'" || value[index - 1] !== '\\')) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ':' && depth === 0 && /\s|$/.test(value[index + 1] ?? '')) {
      const key = parseKey(value.slice(0, index));
      return [key, value.slice(index + 1)];
    }
  }
  return null;
}

function parseKey(value: string): string {
  const key = value.trim();
  if (!key || key.startsWith('?')) throw new Error('IMPORT_SKILL_CONTENT');
  const parsed = parseScalar(key);
  if (typeof parsed !== 'string') throw new Error('IMPORT_SKILL_CONTENT');
  return parsed;
}

function parseScalar(value: string): unknown {
  const text = value.trim();
  if (!text || text.startsWith('!') || text.startsWith('&') || text.startsWith('*')) {
    throw new Error('IMPORT_SKILL_CONTENT');
  }
  if (text.startsWith('[') || text.startsWith('{')) return new FlowParser(text).parse();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('IMPORT_SKILL_CONTENT');
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error('IMPORT_SKILL_CONTENT');
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:null|~)$/i.test(text)) return null;
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error('IMPORT_SKILL_CONTENT');
    return number;
  }
  return text;
}

class FlowParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error('IMPORT_SKILL_CONTENT');
    return value;
  }

  private value(): unknown {
    this.space();
    const char = this.source[this.index];
    if (char === '[') return this.array();
    if (char === '{') return this.object();
    if (char === '"' || char === "'") return this.quoted(char);
    const start = this.index;
    while (this.index < this.source.length && !/[,\]}:]/.test(this.source[this.index]!)) {
      this.index += 1;
    }
    return parseScalar(this.source.slice(start, this.index));
  }

  private array(): unknown[] {
    const result: unknown[] = [];
    this.index += 1;
    this.space();
    while (this.source[this.index] !== ']') {
      result.push(this.value());
      this.space();
      if (this.source[this.index] === ',') this.index += 1;
      else if (this.source[this.index] !== ']') throw new Error('IMPORT_SKILL_CONTENT');
      this.space();
    }
    this.index += 1;
    return result;
  }

  private object(): JsonObject {
    const result: JsonObject = {};
    this.index += 1;
    this.space();
    while (this.source[this.index] !== '}') {
      const keyValue = this.value();
      if (typeof keyValue !== 'string') throw new Error('IMPORT_SKILL_CONTENT');
      this.space();
      if (this.source[this.index] !== ':') throw new Error('IMPORT_SKILL_CONTENT');
      this.index += 1;
      result[keyValue] = this.value();
      this.space();
      if (this.source[this.index] === ',') this.index += 1;
      else if (this.source[this.index] !== '}') throw new Error('IMPORT_SKILL_CONTENT');
      this.space();
    }
    this.index += 1;
    return result;
  }

  private quoted(quote: string): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      if (
        this.source[this.index] === quote &&
        (quote === "'" || this.source[this.index - 1] !== '\\')
      ) {
        this.index += 1;
        return parseScalar(this.source.slice(start, this.index)) as string;
      }
      this.index += 1;
    }
    throw new Error('IMPORT_SKILL_CONTENT');
  }

  private space(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }
}

function stripComment(value: string): string {
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote && (quote === "'" || value[index - 1] !== '\\')) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === '#' && depth === 0 && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
