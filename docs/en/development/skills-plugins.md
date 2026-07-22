# Skills and Plugins

> Related: [Agent engine](./agent-engine.md), [UI](./ui.md), and [Prompts](./prompts.md).

Panelot supports parsing, editing, importing, exporting, progressive disclosure, and slash commands for a single `SKILL.md`. Data-only Plugins can install from a local ZIP, GitHub repository, or archive URL. The curated index exists but currently contains no built-in entries.

## 1. SKILL.md format

```markdown
---
name: example-publisher
description: Rewrite the current article for the target service.
panelot:
  sites: ['*.example.com']
  auto_suggest: true
  command: /publish
  variables:
    - { key: tone, label: Tone, type: select, options: [casual, professional] }
---

# Instructions
```

Frontmatter requires a unique kebab-case name of at most 64 characters and a description from one to 500 characters. Optional `panelot` data defines site patterns, automatic suggestion, a slash command, and structured variables. Unknown fields are retained for compatibility but do not change Panelot permissions.

Dexie stores the raw source, parsed frontmatter and body, enabled state, source type, optional source reference, and timestamps.

## 2. Progressive disclosure

Enabled Skill names and descriptions enter the system prompt index. A site-scoped Skill appears only when the captured default web tab matches. The model calls `load_skill{name}` when it needs the complete body. The read-only tool is allowed by default and loads one Skill body once per Thread.

`SkillManager.suggestionsFor(url)` exists and is tested, but the UI path from page URL changes to suggestion chips is not connected.

## 3. Management and import

Settings edits `SKILL.md` with CodeMirror and validates frontmatter. Import accepts a Markdown file, pasted content, or an HTTPS URL that returns the file directly. It warns when the body references unavailable companion files. A name conflict requires replace or automatic rename.

Each Skill exports as `<name>.SKILL.md`. Multi-file packaging is not supported.

## 4. Slash commands

Skills register `panelot.command` or default to `/{name}`. Executing one attaches the complete Skill body directly to the user message and does not call `load_skill`. MCP Prompts register as `/server:prompt` and call `prompts/get` after any parameter form.

Variables support text, select, date, and URL values with options, default, and required flags. Submission replaces <code v-pre>{{key}}</code> placeholders in the command template.

## 5. Plugin package

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/example/SKILL.md
  presets/research.json
  sites/example.json
```

The manifest declares ID, name, version, optional description, and every asset. Installation accepts local ZIP, repository, tree, archive, and release ZIP URLs. A normal repository resolves its default branch and downloads from codeload. One archive root directory can be stripped safely.

Complete parsing and conflict checks happen before one Dexie installation transaction. A Plugin is a read-only data unit and cannot execute code. Limits are 10 MB compressed, 50 MB actual extracted output, and 1,000 files. Extraction rejects traversal, symbolic links, executable permission bits, and common executable extensions.

Plugin assets must be copied into user ownership before editing. The format does not import MCP configuration or permission rules. There are no automatic updates, ratings, or remote executable assets.

## 6. Site instructions

User settings maintain exact hosts and `*.domain` patterns with prompt text. The background matches them against the target tab and adds them to the system prompt. Enabled Plugin site instructions are read-only and can be copied for editing.

## 7. Current constraints

Claude Code `allowed-tools` and similar fields are preserved but never mapped to Gatekeeper decisions. Imported Skills retain `sourceRef` for manual provenance, and Panelot does not check or apply updates automatically.
