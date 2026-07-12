import { describe, expect, it } from 'vitest';
import { diffSnapshotYaml } from '../../src/tools/snapshot/diff';

describe('snapshot diff', () => {
  it('does not treat ref generation changes as structural changes', () => {
    const before = '# Page Snapshot (s1)\nURL: x\nTitle: x\n\n- button "Save" [ref=s1_1]';
    const after = '# Page Snapshot (s2)\nURL: x\nTitle: x\n\n- button "Save" [ref=s2_1]';
    const result = diffSnapshotYaml(before, after);
    expect(result.changed).toBe(false);
    expect(result.text).toContain('[ref=s2_1]');
    expect(result.text).not.toContain('[ref=s1_1]');
  });

  it('reports additions and removals while returning all current refs', () => {
    const before = '# Page Snapshot (s1)\nURL: x\nTitle: x\n\n- button "Cancel" [ref=s1_1]';
    const after = '# Page Snapshot (s2)\nURL: x\nTitle: x\n\n- button "Delete" [ref=s2_1]';
    const result = diffSnapshotYaml(before, after);
    expect(result.changed).toBe(true);
    expect(result.text).toContain('Delete');
    expect(result.text).toContain('Cancel');
    expect(result.text).toContain('Current interactive refs');
  });
});
