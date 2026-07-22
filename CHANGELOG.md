# Changelog

All notable changes to Panelot are documented here.

## [Unreleased]

### Added

- Added a VitePress documentation site for user guides, development references, and the privacy
  policy, with local search and GitHub Pages deployment.
- Added an English counterpart for every published Chinese documentation page and a build gate
  that rejects missing or unmatched locale paths.

### Changed

- Reorganized engineering documentation under stable semantic paths and clarified that
  user-uploaded file bytes are sent only to an approved target website, not as ordinary model
  attachments.
- Replaced the documentation root privacy page with a product and documentation README, split the
  privacy policy into Chinese and English routes, and linked both repository READMEs to the user
  and development documentation.

## [0.4.4] - 2026-07-21

### Changed

- Centralized tool capability normalization so Provider schemas, recovery fingerprints, trust,
  provenance, and execution bindings derive from one immutable registration contract.
- Consolidated engine event validation behind exhaustive protocol catalogs, preserving forward
  compatibility only for genuinely unknown event types while rejecting malformed known events;
  bounded Engine, content-script, and MCP worker payload resources; and added AST-derived Engine
  and content-script manifests that prevent imported contract changes from leaving stale hashes.
- Added a payload-bound command transaction context so Thread creation, deletion, fork and branch
  selection, queue mutations, approval decisions, and interaction responses commit their domain
  state and idempotent receipt as one database work unit.
- Unified Provider fetch error normalization and retry policy across streaming requests and model
  discovery, including provider-specific request correlation identifiers.

### Fixed

- Removed dynamic imports from the MV3 service worker, where Chrome forbids them, and made Vite's
  error dispatch worker-safe so any future import failure preserves its real cause.
- Stopped replaying page writes after an ambiguous content-script channel failure, preventing
  duplicate clicks, submissions, or text entry when the first operation may already have applied.
- Kept recovered approval and interaction runs as exclusive thread owners until continuation,
  preventing new turns, resumes, queue drains, or branch switches from corrupting their path.
- Reconnected MCP clients when their endpoint or authentication binding changes, and rejected
  connection candidates whose configuration drifted during the handshake.
- Isolated MCP offscreen sessions by connection identity and preserved cancellation across
  cancel-before-admission races, reconnects, replacements, and stale close messages.
- Made thread deletion a background-owned, recovery-safe operation that stops active work and
  atomically removes all thread records while retaining its idempotent command receipt.
- Preserved snapshot-before-live-event ordering during subscriptions, including coalesced stream
  deltas, so reconnecting clients cannot miss or apply events ahead of their snapshot.
- Persisted tool calls with their Run pending state as one work unit, and kept terminal command
  receipts immutable when a later continuation reports an error.
- Applied exact origin semantics to sensitive HTTPS sites and rotated through every configured
  Provider key for authentication failover, including model discovery.
- Made the side-panel conversation layout resilient across narrow and tall viewport ratios, with
  content-measured long-text composer growth, bounded scrolling, and viewport-safe controls.
- Restored the side panel to its last selected conversation after a browser restart, and replaced
  misleading Provider diagnostics and endless loading when the UI must reload to match the worker.
- Simplified default permission-policy cards to their titles and preserved deletion of the shipped
  `run_javascript` deny rule across Service Worker and browser restarts.

## [0.4.3] - 2026-07-16

### Changed

- Strengthened repository quality gates for TypeScript control flow, React hooks, unsafe type
  assertions, auxiliary source type-checking, deterministic tests, and complete `src/` TS/TSX
  coverage accounting.
- Aligned the documented Node.js range with the Vite toolchain and made the local shadcn MCP use
  the lockfile-installed CLI instead of executing an unpinned latest package.

### Fixed

- Revalidated Gatekeeper policy, browser targets, and host permissions immediately before tool
  dispatch so an earlier approval cannot move to changed authorization state.
- Made MCP connection attempts single-flight with serialized disconnect/reconnect barriers and
  failed-client cleanup, validated worker, OAuth, and Provider discovery responses, and removed
  abort-listener leaks from retries and interaction automation.
- Added strict content-script request/result validation, import-journal and decrypted-secret
  validation, reliable draft persistence errors, refreshed composer menus, and UI accessibility,
  i18n, timer, and stale-state fixes.

## [0.4.2] - 2026-07-16

### Added

- Durable interaction workflows for structured questions, user handoff, page-condition watches,
  scheduled resumption, and MCP form elicitation, including recovery-safe persistence and UI cards.
- A built-in artifact tool that saves generated UTF-8 text files to the conversation before
  downloading them.

### Changed

- Strengthened native tool-call guidance, interaction target checks, maintenance-state reporting,
  notifications, and regression coverage across the Agent loop, engine, messaging, MCP, and UI.
- Updated the architecture, data model, browser tools, MCP, UI, prompt, and experience-target
  documentation for the new interaction contracts.

## [0.4.1] - 2026-07-15

### Changed

- Reworked the bilingual README, documentation index, store copy, and UI guidance so they match
  the current permission modes, task-model selector, deep browser tools, and i18n coverage.
- Reconciled the architecture, Agent, browser-tool, permission, Provider, MCP, Plugin, UI, prompt,
  and development guides with the current source and test contracts while keeping experience goals
  explicitly separate from implemented behavior.
- Removed completed Provider diagnostics plan files from the published documentation tree.

## [0.4.0] - 2026-07-15

### Added

- Shared shadcn-based UI primitives for attachments, sidebars, progress, keyboard hints, scrolling,
  tables, and settings surfaces.
- Regression coverage for Agent loop behavior, tool schemas, browser data, page context, message
  rendering, engine reconnects, extension startup, and service-worker recovery.

### Changed

- Hardened browser tools and Agent event handling around result schemas, hidden-tab targeting,
  deep actions, recovery, and tool-result limits.
- Standardized the chat, onboarding, approval, queue, thread, Provider, MCP, Plugin, Skill,
  attachment, permission, and data settings interfaces on shared accessible components.
- Stabilized release verification, bundle budgets, and extension end-to-end tests.

## [0.3.0] - 2026-07-15

### Added

- Background-coordinated data import maintenance with validation, conflict previews, reload
  handoff, and recovery-safe commit markers.
- Runtime schema validation for Agent events, messaging envelopes, maintenance RPC, and imported
  data.
- Run environment snapshots and browser-session routing state for safer service-worker recovery.
- Hardened MCP OAuth discovery, issuer/resource binding, staged host-permission approval, token
  isolation, refresh, and reauthorization flows.
- Browser automation coverage for nested frame geometry, dialog safety, new-tab continuation,
  deep references, and interrupted-run recovery.

### Changed

- Permission settings now expose three default policies: ask throughout, ask for operations, and
  no approval, while explicit permission rules remain mandatory constraints.
- The settings default-model selector now requires a concrete available model; the conversation
  selector's default option follows that configured model unless a Thread preset applies.
- Agent responses now preserve the real interleaving of reasoning, tool calls, progress, and final
  output in one timeline, with clearer provider stop reasons and failure-circuit behavior.
- Settings, onboarding, provider diagnostics, plugins, attachments, data maintenance, and the
  bilingual UI were normalized around shared accessible components and race-safe storage hooks.
- Browser targeting, stale-reference rejection, protocol negotiation, queued commands, and
  connection recovery now fail closed across reloads and document changes.
- CI, release, Pages, bundle budgets, documentation, and regression coverage were expanded for the
  current production architecture.

### Security

- MCP credentials are bound to canonical resources and issuers; access tokens remain session-only
  and persistent secrets stay encrypted.
- Import, endpoint, OAuth, content-script, and Agent-event inputs receive stricter validation before
  they can mutate state or dispatch browser actions.
- Approval recovery revalidates prepared targets, host permissions, deny rules, and manual tab
  activity before dispatch.

## [0.2.0] - 2026-07-12

### Added

- Durable Run, command receipt, approval, Plugin, and attachment provenance records.
- Protocol and schema negotiation with reload-required handling.
- Session outbox replay with stable submission identifiers.
- Local and portable encrypted secret storage.
- On-demand host permission brokering and scoped page execution.
- Raw MCP tool schemas, SDK transport, disabled-tool reconciliation, and lazy connections.
- YAML Skill parsing and atomic ZIP Plugin validation.
- Browser data tools, action evidence, snapshot diffs, and deeper reference handling.
- Thread deletion confirmation and clearer provider diagnostics.

### Changed

- Local storage starts from the `panelot_v1` database.
- Syntax highlighting and rich renderers load on demand.
- Page execution no longer declares permanent host permissions.
- Browser actions use structured failure reasons, actionability checks, bounded retries, and
  stronger CDP fallbacks for difficult controls and frames.
- The Panelot system prompt now distinguishes browser tools, Skills, MCP tools, resources,
  and user-referenced context without claiming unexecuted actions.
- OpenAI-compatible and Anthropic calls preserve request identifiers, honor both Retry-After
  formats, use jittered exponential backoff, and improve Anthropic prompt caching.
- Run recovery, steering persistence, and queued-state transitions are more resilient to
  service-worker interruption.

### Security

- Default exports omit provider and MCP secrets.
- Untrusted context is randomly delimited before model submission.
- Plugin archives reject traversal, symlinks, executable payloads, and archive bombs.
- Provider error details are sanitized before display or persistence.

[Unreleased]: https://github.com/wangdiandao/Panelot/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/wangdiandao/Panelot/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/wangdiandao/Panelot/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/wangdiandao/Panelot/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/wangdiandao/Panelot/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/wangdiandao/Panelot/releases/tag/v0.4.0
[0.3.0]: https://github.com/wangdiandao/Panelot/releases/tag/v0.3.0
[0.2.0]: https://github.com/wangdiandao/Panelot/releases/tag/v0.2.0
