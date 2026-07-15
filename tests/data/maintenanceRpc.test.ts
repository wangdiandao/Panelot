import { describe, expect, it } from 'vitest';
import {
  DATA_IMPORT_RPC_TYPE,
  isTrustedDataImportSender,
  parseDataImportRpcRequest,
} from '../../src/data/maintenanceRpc';

const operationId = '019f597b-58dc-4e40-a272-775bf2cbb346';
const digest = 'a'.repeat(64);

describe('data import maintenance RPC schema', () => {
  it('accepts exact status, preview, and commit requests', () => {
    expect(parseDataImportRpcRequest({ type: DATA_IMPORT_RPC_TYPE, action: 'status' })).toEqual({
      type: DATA_IMPORT_RPC_TYPE,
      action: 'status',
    });
    expect(
      parseDataImportRpcRequest({
        type: DATA_IMPORT_RPC_TYPE,
        action: 'preview',
        operationId,
        input: { version: 1 },
      }),
    ).toMatchObject({ action: 'preview', operationId });
    expect(
      parseDataImportRpcRequest({
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId,
        input: { version: 1 },
        expectedDigest: digest,
        settings: { connections: [] },
        oauthAccessToClear: 2,
        localSecretKey: Array(32).fill(7),
        confirmDiscardDormant: true,
      }),
    ).toMatchObject({
      action: 'commit',
      operationId,
      expectedDigest: digest,
      oauthAccessToClear: 2,
      confirmDiscardDormant: true,
    });
  });

  it('rejects malformed ids, unknown fields, oversized secrets, and invalid digests', () => {
    for (const request of [
      { type: DATA_IMPORT_RPC_TYPE, action: 'status', operationId },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'preview',
        operationId: 'not-an-operation-id',
        input: {},
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'preview',
        operationId,
        input: [],
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'preview',
        operationId,
        input: {},
        passphrase: 'secret',
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId,
        input: {},
        expectedDigest: 'short',
        settings: {},
        oauthAccessToClear: 0,
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId,
        input: {},
        expectedDigest: digest,
        settings: {},
        oauthAccessToClear: 0,
        confirmDiscardDormant: 'yes',
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId,
        input: {},
        expectedDigest: digest,
        settings: {},
        oauthAccessToClear: -1,
      },
      {
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId,
        input: {},
        expectedDigest: digest,
        settings: {},
        oauthAccessToClear: 0,
        localSecretKey: Array(31).fill(1),
      },
      { type: DATA_IMPORT_RPC_TYPE, action: 'finalize', operationId },
      { type: DATA_IMPORT_RPC_TYPE, action: 'abort', operationId },
    ]) {
      expect(parseDataImportRpcRequest(request)).toBeNull();
    }
  });

  it('admits only this extension options page as the privileged sender', () => {
    const root = 'chrome-extension://panelot-id/';
    expect(
      isTrustedDataImportSender(
        { id: 'panelot-id', url: `${root}options.html?section=data` },
        'panelot-id',
        root,
      ),
    ).toBe(true);
    expect(
      isTrustedDataImportSender({ id: 'other-id', url: `${root}options.html` }, 'panelot-id', root),
    ).toBe(false);
    expect(
      isTrustedDataImportSender(
        { id: 'panelot-id', url: 'https://example.test/options.html' },
        'panelot-id',
        root,
      ),
    ).toBe(false);
    expect(
      isTrustedDataImportSender(
        { id: 'panelot-id', url: `${root}sidepanel.html` },
        'panelot-id',
        root,
      ),
    ).toBe(false);
  });
});
