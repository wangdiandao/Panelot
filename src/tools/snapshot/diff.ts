export interface SnapshotDiff {
  text: string;
  changed: boolean;
}

const HEADER_LINES = 4;

function normalize(line: string): string {
  return line.replace(/\[ref=s\d+_\d+\]/g, '[ref]');
}

export function diffSnapshotYaml(previous: string | undefined, next: string): SnapshotDiff {
  if (!previous) return { text: next, changed: true };
  const previousLines = previous.split('\n').slice(HEADER_LINES).filter(Boolean);
  const nextLines = next.split('\n').slice(HEADER_LINES).filter(Boolean);
  const before = new Set(previousLines.map(normalize));
  const after = new Set(nextLines.map(normalize));
  const added = nextLines.filter((line) => !before.has(normalize(line)));
  const removed = previousLines.filter((line) => !after.has(normalize(line))).map(normalize);
  const refs = nextLines.filter((line) => /\[ref=s\d+_\d+\]/.test(line));
  const generation = /^# Page Snapshot \((s\d+)\)/.exec(next)?.[1] ?? 'unknown';
  const sections = [`# Page Changes (${generation})`];
  if (added.length) sections.push(`Added/changed:\n${added.join('\n')}`);
  if (removed.length) sections.push(`Removed:\n${removed.join('\n')}`);
  if (refs.length) sections.push(`Current interactive refs:\n${refs.join('\n')}`);
  if (!added.length && !removed.length) sections.push('No structural change detected.');
  return { text: sections.join('\n\n'), changed: added.length > 0 || removed.length > 0 };
}
