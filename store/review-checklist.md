# Store review checklist

- [ ] Version in `package.json`, manifest, ZIP name, changelog, and release tag match.
- [ ] Chrome and Edge ZIP smoke tests pass and contain no source maps.
- [ ] Manifest has no permanent host permissions and retains optional `<all_urls>`.
- [ ] Fresh-profile onboarding works without any pre-granted host access.
- [ ] Provider verification requests permission from a visible user gesture.
- [ ] MCP OAuth, bearer authentication, disabled tools, prompts, and resources are exercised manually.
- [ ] L1 and L2 approval labels match the destination tab and origin.
- [ ] Default export contains no secrets; encrypted backup round-trip succeeds.
- [ ] Plugin traversal, symlink, executable, file-count, and size rejection tests pass.
- [ ] English and Chinese store descriptions, screenshots, permission rationale, and data disclosure are current.
- [ ] Documentation Pages deployment serves the privacy policy at the submitted URL.
- [ ] Real OpenAI-compatible, Anthropic-compatible, and MCP compatibility matrix is signed off.
