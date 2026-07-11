declare module 'js-yaml' {
  export type Schema = object;
  export const CORE_SCHEMA: Schema;
  export function load(
    input: string,
    options?: { schema?: Schema; json?: boolean; filename?: string },
  ): unknown;
}
