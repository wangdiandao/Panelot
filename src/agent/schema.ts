export interface SchemaIssue {
  path: PropertyKey[];
  message: string;
}

export type SchemaParseResult<Output> =
  { success: true; data: Output } | { success: false; error: { issues: SchemaIssue[] } };

export interface RuntimeSchema<Output = unknown> {
  readonly panelotOptional?: boolean;
  readonly jsonSchema?: Record<string, unknown>;
  safeParse(input: unknown): SchemaParseResult<Output>;
}

export type Infer<T extends RuntimeSchema> = T extends RuntimeSchema<infer Output> ? Output : never;

interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  url?: boolean;
  description?: string;
}

interface NumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
  description?: string;
}

interface ArrayOptions {
  min?: number;
  max?: number;
}

type Shape = Record<string, RuntimeSchema>;
type OptionalKeys<T extends Shape> = {
  [Key in keyof T]: undefined extends Infer<T[Key]> ? Key : never;
}[keyof T];
type RequiredKeys<T extends Shape> = Exclude<keyof T, OptionalKeys<T>>;
type ObjectOutput<T extends Shape> = {
  [Key in RequiredKeys<T>]: Infer<T[Key]>;
} & {
  [Key in OptionalKeys<T>]?: Exclude<Infer<T[Key]>, undefined>;
};

type Parser<Output> = (input: unknown, path: PropertyKey[]) => Output;

class ValidationError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(issues[0]?.message ?? 'Invalid value');
  }
}

function invalid(path: PropertyKey[], message: string): never {
  throw new ValidationError([{ path, message }]);
}

function runtimeSchema<Output>(
  parser: Parser<Output>,
  jsonSchema: Record<string, unknown>,
  panelotOptional = false,
): RuntimeSchema<Output> {
  return {
    panelotOptional,
    jsonSchema,
    safeParse(input) {
      try {
        return { success: true, data: parser(input, []) };
      } catch (error) {
        if (error instanceof ValidationError) return { success: false, error };
        throw error;
      }
    },
  };
}

function parseAt<Output>(
  schema: RuntimeSchema<Output>,
  input: unknown,
  path: PropertyKey[],
): Output {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: [...path, ...issue.path],
      message: issue.message,
    })),
  );
}

function string(options: StringOptions = {}): RuntimeSchema<string> {
  const jsonSchema: Record<string, unknown> = { type: 'string' };
  if (options.min !== undefined) jsonSchema.minLength = options.min;
  if (options.max !== undefined) jsonSchema.maxLength = options.max;
  if (options.pattern) jsonSchema.pattern = options.pattern.source;
  if (options.url) jsonSchema.format = 'uri';
  if (options.description) jsonSchema.description = options.description;
  return runtimeSchema((input, path) => {
    if (typeof input !== 'string') return invalid(path, 'Expected string');
    if (options.min !== undefined && input.length < options.min) {
      return invalid(path, `Expected string to have >=${options.min} characters`);
    }
    if (options.max !== undefined && input.length > options.max) {
      return invalid(path, `Expected string to have <=${options.max} characters`);
    }
    if (options.pattern) {
      options.pattern.lastIndex = 0;
      const matches = options.pattern.test(input);
      options.pattern.lastIndex = 0;
      if (!matches) {
        return invalid(
          path,
          options.patternMessage ?? `Invalid string: must match ${options.pattern}`,
        );
      }
    }
    if (options.url) {
      try {
        new URL(input);
      } catch {
        return invalid(path, 'Invalid URL');
      }
    }
    return input;
  }, jsonSchema);
}

function number(options: NumberOptions = {}): RuntimeSchema<number> {
  const jsonSchema: Record<string, unknown> = { type: options.integer ? 'integer' : 'number' };
  if (options.min !== undefined) jsonSchema.minimum = options.min;
  if (options.max !== undefined) jsonSchema.maximum = options.max;
  if (options.description) jsonSchema.description = options.description;
  return runtimeSchema((input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return invalid(path, `Expected ${options.integer ? 'int' : 'number'}`);
    }
    if (options.integer && !Number.isSafeInteger(input)) return invalid(path, 'Expected int');
    if (options.min !== undefined && input < options.min) {
      return invalid(path, `Expected number to be >=${options.min}`);
    }
    if (options.max !== undefined && input > options.max) {
      return invalid(path, `Expected number to be <=${options.max}`);
    }
    return input;
  }, jsonSchema);
}

function boolean(): RuntimeSchema<boolean> {
  return runtimeSchema(
    (input, path) => (typeof input === 'boolean' ? input : invalid(path, 'Expected boolean')),
    { type: 'boolean' },
  );
}

function literal<const Value extends string | number | boolean | null>(
  value: Value,
): RuntimeSchema<Value> {
  return runtimeSchema(
    (input, path) => (Object.is(input, value) ? value : invalid(path, `Expected ${String(value)}`)),
    { const: value },
  );
}

function enumValue<const Values extends readonly string[]>(
  values: Values,
): RuntimeSchema<Values[number]> {
  const allowed = new Set<string>(values);
  return runtimeSchema(
    (input, path) =>
      typeof input === 'string' && allowed.has(input)
        ? (input as Values[number])
        : invalid(path, `Expected one of ${values.join(', ')}`),
    { type: 'string', enum: [...values] },
  );
}

function optional<Output>(value: RuntimeSchema<Output>): RuntimeSchema<Output | undefined> {
  return runtimeSchema(
    (input, path) => (input === undefined ? undefined : parseAt(value, input, path)),
    jsonOf(value),
    true,
  );
}

function array<Output>(
  item: RuntimeSchema<Output>,
  options: ArrayOptions = {},
): RuntimeSchema<Output[]> {
  const jsonSchema: Record<string, unknown> = { type: 'array', items: jsonOf(item) };
  if (options.min !== undefined) jsonSchema.minItems = options.min;
  if (options.max !== undefined) jsonSchema.maxItems = options.max;
  return runtimeSchema((input, path) => {
    if (!Array.isArray(input)) return invalid(path, 'Expected array');
    if (options.min !== undefined && input.length < options.min) {
      return invalid(path, `Expected array to have >=${options.min} items`);
    }
    if (options.max !== undefined && input.length > options.max) {
      return invalid(path, `Expected array to have <=${options.max} items`);
    }
    return input.map((entry, index) => parseAt(item, entry, [...path, index]));
  }, jsonSchema);
}

function object<const T extends Shape>(shape: T): RuntimeSchema<ObjectOutput<T>> {
  return objectSchema(shape, false);
}

function looseObject<const T extends Shape>(
  shape: T,
): RuntimeSchema<ObjectOutput<T> & Record<string, unknown>> {
  return objectSchema(shape, true) as RuntimeSchema<ObjectOutput<T> & Record<string, unknown>>;
}

function objectSchema<const T extends Shape>(
  shape: T,
  loose: boolean,
): RuntimeSchema<ObjectOutput<T>> {
  const properties = Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, jsonOf(value)]),
  );
  const required = Object.entries(shape)
    .filter(([, value]) => !value.panelotOptional)
    .map(([key]) => key);
  return runtimeSchema(
    (input, path) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return invalid(path, 'Expected object');
      }
      const source = input as Record<string, unknown>;
      if (!loose) {
        for (const key of Object.keys(source)) {
          if (!Object.prototype.hasOwnProperty.call(shape, key)) {
            return invalid([...path, key], 'Unknown field');
          }
        }
      }
      const output: Record<string, unknown> = loose ? { ...source } : {};
      for (const [key, value] of Object.entries(shape)) {
        const present = Object.prototype.hasOwnProperty.call(source, key);
        if (!present && value.panelotOptional) continue;
        if (!present) return invalid([...path, key], 'Required field is missing');
        output[key] = parseAt(value, source[key], [...path, key]);
      }
      return output as ObjectOutput<T>;
    },
    {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: loose ? {} : false,
    },
  );
}

function record<Key extends string, Output>(
  key: RuntimeSchema<Key>,
  value: RuntimeSchema<Output>,
): RuntimeSchema<Record<string, Output>> {
  return runtimeSchema(
    (input, path) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return invalid(path, 'Expected record');
      }
      const output: Record<string, Output> = {};
      for (const [entryKey, entryValue] of Object.entries(input)) {
        parseAt(key, entryKey, [...path, entryKey]);
        output[entryKey] = parseAt(value, entryValue, [...path, entryKey]);
      }
      return output;
    },
    {
      type: 'object',
      propertyNames: jsonOf(key),
      additionalProperties: jsonOf(value),
    },
  );
}

function union<const Values extends readonly RuntimeSchema[]>(
  values: Values,
): RuntimeSchema<Infer<Values[number]>> {
  return runtimeSchema(
    (input, path) => {
      const failures: SchemaIssue[] = [];
      for (const value of values) {
        try {
          return parseAt(value, input, path) as Infer<Values[number]>;
        } catch (error) {
          if (error instanceof ValidationError) failures.push(...error.issues);
          else throw error;
        }
      }
      throw new ValidationError(failures.slice(0, 1));
    },
    { anyOf: values.map((value) => jsonOf(value)) },
  );
}

function unknown(): RuntimeSchema<unknown> {
  return runtimeSchema((input) => input, {});
}

function safeParse<Output>(
  value: RuntimeSchema<Output>,
  input: unknown,
): SchemaParseResult<Output> {
  return value.safeParse(input);
}

function parse<Output>(value: RuntimeSchema<Output>, input: unknown): Output {
  const result = value.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(result.error.issues);
}

function toJSONSchema(value: RuntimeSchema, _options?: { io?: 'input' | 'output' }) {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...jsonOf(value) };
}

function jsonOf(value: RuntimeSchema): Record<string, unknown> {
  if (value.jsonSchema) return value.jsonSchema;
  const definition = (value as RuntimeSchema & { _zod?: { def?: Record<string, unknown> } })._zod
    ?.def;
  if (!definition) return {};
  switch (definition.type) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'unknown':
      return {};
    case 'optional':
      return jsonOf(definition.innerType as RuntimeSchema);
    case 'array':
      return { type: 'array', items: jsonOf(definition.element as RuntimeSchema) };
    case 'object': {
      const shape = definition.shape as Record<string, RuntimeSchema>;
      const properties = Object.fromEntries(
        Object.entries(shape).map(([key, entry]) => [key, jsonOf(entry)]),
      );
      const required = Object.entries(shape)
        .filter(
          ([, entry]) =>
            (entry as RuntimeSchema & { _zod?: { def?: { type?: string } } })._zod?.def?.type !==
            'optional',
        )
        .map(([key]) => key);
      return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}

export const schema = {
  array,
  boolean,
  enum: enumValue,
  literal,
  looseObject,
  number,
  object,
  optional,
  parse,
  record,
  safeParse,
  string,
  toJSONSchema,
  union,
  unknown,
};
