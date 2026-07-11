# Contributing to Panelot

Panelot is a WXT, React, and TypeScript Chrome MV3 extension. Read `AGENTS.md`, `DESIGN.md`, and the relevant file under `docs/` before changing behavior.

## Development

Use Node.js 20.12 or newer and pnpm 9.12.3:

```bash
pnpm install --frozen-lockfile
pnpm compile
pnpm test
pnpm e2e
pnpm build
```

Changes should include focused regression tests. Keep credentials, real browsing data, generated release archives, and temporary diagnostics out of commits. Temporary scripts belong in `scratch/` and must be removed before submitting a change.

## Pull requests

- Explain the user-visible behavior and security implications.
- Keep protocol, storage, permission, and prompt changes consistent with the design documents.
- Update `CHANGELOG.md` for release-facing changes.
- Confirm that the production manifest has no permanent host permissions.
- Do not include provider keys, MCP tokens, OAuth tokens, page content, or personal screenshots.

By contributing, you agree that your contribution is licensed under the MIT License.
