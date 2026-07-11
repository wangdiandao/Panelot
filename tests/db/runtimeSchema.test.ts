import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';

describe('panelot runtime schema', () => {
  it('uses an isolated database for the incompatible runtime protocol', () => {
    const db = new PanelotDB();
    expect(db.name).toBe('panelot_v1');
  });

  it('contains durable run, receipt, approval, and plugin tables', () => {
    const db = new PanelotDB(`schema-test-${Date.now()}`);
    expect(db.tables.map((table) => table.name).sort()).toEqual(
      [
        'approvals',
        'attachments',
        'commandReceipts',
        'memories',
        'nodes',
        'plugins',
        'pluginAssets',
        'runs',
        'skills',
        'threads',
      ].sort(),
    );
  });
});
