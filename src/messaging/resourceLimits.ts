export interface CrossContextValueLimits {
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxStringCodeUnits: number;
  maxBinaryBytes: number;
}

interface TraversalEntry {
  value: unknown;
  depth: number;
  exit?: object;
}

function diagnostic(path: string, detail: string): string {
  return `${path}: ${detail}`;
}

/**
 * Applies a cheap, iterative resource budget before detailed protocol checks.
 * The limits are deliberately generous: they reject pathological messages
 * without constraining normal screenshots, thread snapshots, or tool results.
 */
export function validateCrossContextValueSize(
  value: unknown,
  path: string,
  limits: CrossContextValueLimits,
  options: { rejectCycles?: boolean } = {},
): string | undefined {
  const stack: TraversalEntry[] = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let stringCodeUnits = 0;
  let binaryBytes = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.exit) {
      active.delete(entry.exit);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) return diagnostic(path, 'message structure is too large');
    if (entry.depth > limits.maxDepth) return diagnostic(path, 'message nesting is too deep');

    if (typeof entry.value === 'string') {
      stringCodeUnits += entry.value.length;
      if (stringCodeUnits > limits.maxStringCodeUnits) {
        return diagnostic(path, 'message text is too large');
      }
      continue;
    }
    if (typeof entry.value !== 'object' || entry.value === null) continue;
    if (visited.has(entry.value)) {
      if (options.rejectCycles && active.has(entry.value)) {
        return diagnostic(path, 'expected an acyclic message value');
      }
      continue;
    }
    visited.add(entry.value);
    active.add(entry.value);
    stack.push({ value: undefined, depth: entry.depth, exit: entry.value });

    if (entry.value instanceof ArrayBuffer) {
      binaryBytes += entry.value.byteLength;
      if (binaryBytes > limits.maxBinaryBytes)
        return diagnostic(path, 'binary payload is too large');
      continue;
    }
    if (ArrayBuffer.isView(entry.value)) {
      binaryBytes += entry.value.byteLength;
      if (binaryBytes > limits.maxBinaryBytes)
        return diagnostic(path, 'binary payload is too large');
      continue;
    }
    if (typeof Blob !== 'undefined' && entry.value instanceof Blob) {
      binaryBytes += entry.value.size;
      if (binaryBytes > limits.maxBinaryBytes)
        return diagnostic(path, 'binary payload is too large');
      continue;
    }
    if (Array.isArray(entry.value)) {
      if (entry.value.length > limits.maxArrayLength) {
        return diagnostic(path, 'message array is too large');
      }
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry.value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    if (entry.value instanceof Map) {
      if (entry.value.size > limits.maxObjectKeys) {
        return diagnostic(path, 'message map is too large');
      }
      for (const [key, nested] of entry.value) {
        stack.push({ value: nested, depth: entry.depth + 1 });
        stack.push({ value: key, depth: entry.depth + 1 });
      }
      continue;
    }
    if (entry.value instanceof Set) {
      if (entry.value.size > limits.maxArrayLength) {
        return diagnostic(path, 'message set is too large');
      }
      for (const nested of entry.value) {
        stack.push({ value: nested, depth: entry.depth + 1 });
      }
      continue;
    }

    const keys = Object.keys(entry.value);
    if (keys.length > limits.maxObjectKeys) {
      return diagnostic(path, 'message object has too many fields');
    }
    for (const key of keys) {
      stringCodeUnits += key.length;
      if (stringCodeUnits > limits.maxStringCodeUnits) {
        return diagnostic(path, 'message text is too large');
      }
      stack.push({
        value: (entry.value as Record<string, unknown>)[key],
        depth: entry.depth + 1,
      });
    }
  }
  return undefined;
}

export function validateBoundedJsonValue(
  value: unknown,
  path: string,
  limits: Omit<CrossContextValueLimits, 'maxBinaryBytes'>,
): string | undefined {
  const budgetIssue = validateCrossContextValueSize(
    value,
    path,
    {
      ...limits,
      maxBinaryBytes: 0,
    },
    { rejectCycles: true },
  );
  if (budgetIssue) return budgetIssue;

  const stack: TraversalEntry[] = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (
      entry.value === null ||
      typeof entry.value === 'string' ||
      typeof entry.value === 'boolean'
    ) {
      continue;
    }
    if (typeof entry.value === 'number') {
      if (Number.isFinite(entry.value)) continue;
      return diagnostic(path, 'expected a finite JSON number');
    }
    if (typeof entry.value !== 'object') return diagnostic(path, 'expected a JSON value');
    if (visited.has(entry.value)) continue;
    visited.add(entry.value);
    if (Array.isArray(entry.value)) {
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry.value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(entry.value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return diagnostic(path, 'expected a plain JSON object');
    }
    for (const key of Object.keys(entry.value)) {
      stack.push({
        value: (entry.value as Record<string, unknown>)[key],
        depth: entry.depth + 1,
      });
    }
  }
  return undefined;
}
