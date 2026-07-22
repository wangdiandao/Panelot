# Data model and storage

> Related: [Architecture](./architecture.md) and [Agent engine](./agent-engine.md).

## 1. Storage rules

1. A conversation is stored as a tree of nodes with `{ id, parentId }`. Edit, regenerate, and branch operations append siblings and move the current leaf instead of maintaining a parallel flat message array.
2. Nodes are append-oriented. Streaming deltas are not nodes. The final assistant result is written after the provider stream completes. Message deletion uses a tombstone, and recovery replays nodes rather than deserializing a separate snapshot.
3. Model history is derived. `buildSessionContext(leafId)` walks from the leaf to the root and returns a linear provider-neutral message sequence.

## 2. Dexie schema

Database `panelot_v1` has these tables:

| Table | Purpose |
| --- | --- |
| `threads` | Lightweight conversation list metadata and current leaf |
| `nodes` | Append-only conversation tree |
| `attachments` | File, image, screenshot, page snapshot, and page text Blobs |
| `skills`, `memories` | Skill source and agent memory data |
| `runs` | Durable execution state and environment snapshots |
| `commandReceipts` | Idempotent client command terminal state |
| `approvals`, `interactions` | Pending and resolved user RPC state |
| `plugins`, `pluginAssets` | Plugin ownership and validated read-only assets |

Provider configuration, permission rules, and UI preferences use `chrome.storage.local` because they are smaller and need cross-context change events.

Assistant nodes can store provider-specific replay state separately from visible reasoning. Anthropic uses this field for signed and redacted thinking blocks that must accompany a later tool-result request. Import validation accepts only the defined bounded structure.

### 2.1 Threads

`ThreadMeta` stores title, timestamps, `leafId`, optional folder and preset, tags, pin and archive flags, optional `parentThreadId`, usage statistics, and origins reached or approved by the Thread. The UI reads this table for the conversation list instead of scanning nodes.

### 2.2 Nodes

`ThreadNode` contains a UUID, Thread ID, parent ID, monotonic per-Thread sequence, timestamp, discriminated type, and payload. Node types include user and assistant messages, tool calls and results, approval decisions, interaction responses, Turn context, and system notices.

Child IDs are derived from `parentId` and never stored. Tool calls and results are separate because approval can pause for an arbitrary time. Large UI details belong in attachments instead of inline results. Streaming deltas and the L1 selector map remain in memory.

### 2.3 Attachments

Attachments record kind, MIME type, Blob bytes, trust, provenance, source, node or Run references, deletion state, and optional page or image metadata. They have a separate 200 MB management budget. Eviction marks references before deleting bytes.

### 2.4 Command receipts

The receipt key is `clientId + submissionId`. It stores command type, status, terminal response, and an optional SHA-256 request fingerprint. The fingerprint excludes transport identity and does not copy input text. A completed receipt cannot be overwritten.

## 3. Tree operations

### 3.1 Append

`appendNode` assigns the next sequence, writes the node, moves `thread.leafId`, and updates the Thread timestamp.

### 3.2 Edit, regenerate, and branch

Editing a user message appends a sibling under the original parent. Regeneration appends a new assistant branch under the user message. The branch selector orders siblings by sequence and follows the newest default descendants when switching.

### 3.3 Delete

A message tombstone sets `payload.deleted = true`. Context derivation skips it and reconnects its children to the visible ancestor. Physical deletion is reserved for an entire Thread or quota cleanup.

`thread.delete` first stops admission and active or recovered execution, then deletes Thread nodes, attachments, Runs, approvals, interactions, and metadata in one transaction with the command receipt acknowledgement. The receipt remains so a lost acknowledgement can be replayed after worker restart.

### 3.4 Integrity

A parent must exist in the same Thread or be `null` for a root. On load, `leafId` must reach a root. Corrupt data falls back to the highest-sequence reachable leaf and produces a system notice. Walk length is bounded by node count.

## 4. Session context

`buildSessionContext` reverses the leaf-to-root path, omits tombstones and engine metadata, and produces provider-neutral messages plus the latest Turn context. Prompt assembly happens separately in `src/prompts/assemble.ts`. The UI snapshot also excludes `turn_context` and `interaction_response`. Full JSON exports retain those records for recovery and audit, and import validation checks their payloads before restoring them.

Before execution, `runTurn` stores normalized input and a versioned `RunEnvironmentSnapshot` with a SHA-256 integrity digest. The snapshot fixes the connection, model, parameters, complete system prompt, Skill content, provider tool schemas, execution bindings, permission policy, browser submission context, and capability or pricing metadata.

Secrets are not copied into the snapshot. It stores credential references. Recovery rejects invalid versions, digest mismatch, binding drift, or oversized structure, while allowing encrypted values behind the same reference to rotate.

## 5. Quota and cleanup

Settings uses `navigator.storage.estimate()` and warns above 80% usage. Attachment cleanup removes the oldest attachments outside the active Thread after the 200 MB budget. An automatic archive-after-N-days retention policy is a target and is not currently scheduled.

## 6. Current constraints

Sibling lookup uses the `parentId` index and filters by Thread in memory because branch counts are small. Attachments use IndexedDB Blobs instead of OPFS for browser compatibility.
