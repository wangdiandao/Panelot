# Changelog

All notable changes to Panelot are documented here.

## [Unreleased]

## [0.2.0] - 2026-07-10

### Added

- Durable Run, command receipt, approval, Plugin, and attachment provenance records.
- Protocol and schema negotiation with reload-required handling.
- Session outbox replay with stable submission identifiers.
- Local and portable encrypted secret storage.
- On-demand host permission brokering and scoped page execution.
- Raw MCP tool schemas, SDK transport, disabled-tool reconciliation, and lazy connections.
- YAML Skill parsing and atomic ZIP Plugin validation.

### Changed

- Local storage starts from the `panelot_v1` database.
- Syntax highlighting and rich renderers load on demand.
- Page execution no longer declares permanent host permissions.

### Security

- Default exports omit provider and MCP secrets.
- Untrusted context is randomly delimited before model submission.
- Plugin archives reject traversal, symlinks, executable payloads, and archive bombs.

[Unreleased]: https://github.com/wangdiandao/Panelot/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wangdiandao/Panelot/releases/tag/v0.2.0
