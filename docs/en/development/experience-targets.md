# Experience targets and validation boundaries

> This page lists product targets and measurement methods. Percentages, latency values, and sample sizes are calibration goals, not promises met by the current release. Source code, runtime-contract pages, and tests describe current behavior.

## 1. Status terms

- **Implemented**: a code path exists and can be checked through source or tests.
- **Partially implemented**: the main path exists with a named gap.
- **Target**: a later measurement or design objective that must not appear as a current release capability.

External comparisons were recorded in July 2026 and were not re-tested for this documentation change.

## 2. Chat experience

The side panel and full-page chat share a Thread, message stream, and composer. Streaming, steering, queueing, branches, approval cards, and recovery cards exist. Timing still needs dedicated performance tests.

| ID | Target | Method |
| --- | --- | --- |
| CH-1 | Show the user message and running state within 100 ms, and roll back optimistic input on rejection | Extension e2e timing |
| CH-2 | Add no perceptible local delay beyond first-token time; coalesce deltas at 16 ms | Instrumentation |
| CH-3 | Stop a Turn and update UI within 200 ms of Esc | Extension e2e timing |
| CH-4 | Render reasoning, Tools, intermediate text, and final output in arrival order | UI integration tests |
| CH-5 | Apply steering before the next model call and identify queue fallback | Engine tests and e2e |
| CH-6 | Switch a local branch under 100 ms for up to 1,000 nodes | Performance test |
| CH-7 | Restore a 1,000-node conversation under 500 ms after reopening | Cold-start test |
| CH-8 | Stream Markdown, code, tables, KaTeX, and Mermaid without flicker or unhandled errors | Visual and component tests |

Panelot does not animate output character by character. Model and endpoint determine first-token latency; measurements isolate Panelot overhead.

## 3. Browser actions

| ID | Target | Method |
| --- | --- | --- |
| OP-1 | L1 snapshots cover at least 95% of interactive elements in fixtures | Baseline snapshot comparison |
| OP-2 | Click, type, and select succeed at least 90% on first execution | Fixed fixtures |
| OP-3 | Total success including stale-ref recovery reaches at least 98% | Fixed fixtures |
| OP-4 | One action has p50 at most 1.2 seconds and p95 at most 6 seconds | Instrumentation |
| OP-5 | A five-field form usually completes within two model round trips | Agent regression set |
| OP-6 | Ordinary snapshots have p95 at most 300 ms, heavy SPAs at most 1 second | Performance test |
| OP-7 | L2 attaches only when needed and post-task attachment time is measured and reduced | CDP lifecycle data |
| OP-8 | Use the current browser login state without another automation profile | Production extension e2e |
| OP-9 | Pause the Thread within 300 ms after manual input in a controlled tab | Production extension e2e |
| OP-10 | Stop repetition on the same failure path and return a structured error or change perception method | Unit and agent tests |

Synthetic L1 input can be ignored. Type may request one trusted retry after explicit failure; click has no reliable automatic escalation test. Deep reads cover cross-origin iframe, nested OOPIF, and accessible closed-shadow content. CDP attaches serially per tab and detaches after 30 seconds idle. Network interception, recording, headless batches, Firefox, and WebKit are outside scope.

## 4. Provider setup

| ID | Target | Method |
| --- | --- | --- |
| PV-1 | A new user sends the first message within 60 seconds of opening settings | Usability test |
| PV-2 | Common connection errors show attribution, a safe upstream summary, and a next step | Provider matrix |
| PV-3 | Discover models concurrently without one failed connection blocking another | Unit and fault tests |
| PV-4 | Maintain a streaming and Tool compatibility matrix for at least ten common endpoints | Manual release matrix |
| PV-5 | Key failover preserves completed chat content and does not repeat browser writes | Fault injection |

Provider templates are configuration starting points, not compatibility guarantees.

## 5. Approval and security

| ID | Target | Method |
| --- | --- | --- |
| AP-1 | A user can judge target, parameters, and outcome from an approval card without reading documentation | Usability test |
| AP-2 | Baseline tasks interrupt only when required and do not repeat questions for reads | Approval event data |
| AP-3 | Keyboard decisions work immediately after a card appears | Extension e2e |
| AP-4 | Notifications open the waiting Thread and timeouts close as denied | Notification and recovery e2e |
| AP-5 | Fake system text, approval text, and cross-origin inducement cannot bypass Gatekeeper | Security regression set |
| AP-6 | A denied Tool is not repeated unchanged | Agent regression set |

Settings never remove Gatekeeper. Approval and interaction UI stays in extension pages. User questions, takeover, and MCP Elicitation pause Runs durably; page conditions and timers recover through alarms or listeners.

## 6. Skills, Plugins, and MCP

| ID | Target | Current check |
| --- | --- | --- |
| EC-1 | Import common single-file Skills and warn before missing multi-file dependencies | File, URL, and YAML tests; community sample set still needed |
| EC-2 | Recognize remote MCP fragments from Claude Code and Cursor | Parser tests |
| EC-3 | Keep OAuth steps short and authorization origins visible | OAuth e2e and manual check |
| EC-4 | Keep only Skill names and descriptions in the index and load bodies on demand | Prompt assembly tests |
| EC-5 | Require every Plugin asset in the manifest and reject code, traversal, symlinks, and oversized archives | Plugin security tests |

Plugin automatic updates, marketplace ratings, and executable content are outside scope. Skill matching exists, but side-panel automatic-suggestion chips are not connected.

## 7. Reliability and onboarding

| ID | Target | Method |
| --- | --- | --- |
| RL-1 | Preserve submitted input and completed Tool results across worker interruption | Engine recovery tests |
| RL-2 | Keep a 2,000-node conversation scrollable without blocking input | Performance test |
| RL-3 | Release snapshot and CDP route state after tab close | Unit and manual profile test |
| RL-4 | Warn above 80% quota and avoid deleting the active conversation during cleanup | Data and UI tests |
| OB-1 | Reach a valid first answer within two minutes of installation | New-profile usability test |
| OB-2 | Understand the three permission modes before the first action | Usability test |
| OB-3 | Show suggestions related to page type and leave them editable | UI test |
| OB-4 | Open connection settings directly when no model is configured | Extension e2e |

## 8. Current validation

Vitest covers protocol validation, conversation trees, provider streams, Gatekeeper, recovery, Plugin import, MCP OAuth, refs, actionability, and structured action errors. Playwright loads the production unpacked extension in persistent Chromium and covers manifest, settings, page execution, nested OOPIF deep refs, trusted input, approval, and interruption recovery.

These tests do not prove the success rates and latency targets above or replace compatibility checks against real providers, MCP servers, and websites.

Remaining work includes complete notification-to-approval timeout e2e, stable latency and memory baselines, manual provider and MCP compatibility matrices, Skill suggestion UI, and non-empty curated Plugin publication.

## 9. Calibration

After the first stable measurement, record it as the baseline. Change a target only when test environment, sample set, or product scope changes, and document the conditions. Group model-dependent measurements by model and endpoint rather than generalizing from one success.
