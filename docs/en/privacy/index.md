---
title: Panelot privacy policy
description: Privacy policy for the Panelot browser extension
outline: [2, 3]
---

# Panelot privacy policy

Effective date: 2026-07-10

Panelot is a local-first browser extension. It does not operate a Panelot account service, cloud sync service, advertising system, or telemetry pipeline.

## Data processed

Panelot stores conversations, settings, Skills, Plugins, approvals, and attachments in the browser profile. Provider API keys, MCP bearer tokens, OAuth refresh tokens, and sensitive custom headers are encrypted locally. OAuth access tokens remain in the browser session only.

When you ask Panelot to use a model, the prompt, relevant conversation history, selected page or text context, user-uploaded file metadata, and tool results are sent directly to the provider connection you configured. User-uploaded file bytes are not sent as ordinary model attachments. When you enable an MCP server, tool arguments and relevant results are exchanged directly with that server. Those third parties process data under their own policies.

Panelot reads or changes a website only when a task requires it and the browser grants access. Website host access is optional and requested at runtime. If you approve uploading a local file to a website, its bytes are sent to that website. Page content and files are not uploaded to Panelot-operated servers.

## Sharing and retention

Panelot does not sell personal data and does not send analytics. Local records remain until you delete them, clear extension data, or uninstall the extension. Export files are created only at your request. Default exports omit secrets. Password-protected secret backups use PBKDF2-SHA-256 and AES-GCM.

## Your choices

You can revoke site access in browser extension settings, disable or remove providers and MCP servers, delete conversations and attachments, export non-secret data, or uninstall Panelot. Revoking a third-party token may also require using that provider's account controls.

Report security issues privately by following [`SECURITY.md`](https://github.com/wangdiandao/Panelot/blob/main/SECURITY.md) in the Panelot repository.
