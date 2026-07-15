# Design QA

## Evidence

- Source visual truth:
  - `C:\Users\Lenovo\AppData\Local\Temp\codex-clipboard-6cc3807a-039f-4516-9618-d6994d4bd3a7.png`
  - `C:\Users\Lenovo\AppData\Local\Temp\codex-clipboard-ca5c7e5a-6d47-40a3-b7c7-9079318e3354.png`
- Browser-rendered implementation:
  - `E:\repos\Panelot\scratch\playwright\codex-chat\panelot-chat-final.png`
  - `E:\repos\Panelot\scratch\playwright\codex-chat\panelot-chat-final-bottom.png`
- URL: `http://localhost:5391/`
- Primary viewport: 1440 × 900, CSS pixel scale
- Responsive checks: 900 × 800 and 640 × 800
- Theme and state: dark theme; one completed Agent message with process collapsed and result visible; one active Agent message with process expanded.

## Full-view comparison evidence

The two Codex Desktop source crops and the 1440 × 900 implementation capture were opened together in one comparison input. The implementation preserves the source hierarchy: a quiet one-line process summary, a thin divider, flat process content when expanded, and an unboxed final answer. The full-page layout intentionally retains Panelot's thread sidebar and composer while removing the detached right activity panel.

## Focused region comparison evidence

The source images already crop tightly to the Agent message region. The bottom-aligned implementation capture isolates the corresponding completed and running message regions at readable scale, so no additional crop was needed. The completed state shows `已处理 9s` with a collapsed chevron and visible answer; the running state shows `处理中` with reasoning and tool execution visible below it.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Typography: the system UI stack, compact status label, body weight, line height, and muted metadata preserve the Codex-like hierarchy without introducing a display font or oversized title treatment.
- Spacing and layout: nested response cards were removed; status, divider, process, result, citations, and actions now form one continuous message. The 768px content cap remains intentional for Panelot. No horizontal overflow was present at 900px or 640px.
- Colors and tokens: background, muted foreground, dividers, status colors, and tool metadata use the existing shadcn theme tokens and maintain the restrained dark palette visible in the source.
- Image quality and assets: the target contains no imagery, logos, or decorative raster assets. Lucide icons remain code-native UI icons; no source image was replaced with a CSS or SVG approximation.
- Copy and content: `处理中` and `已处理` clearly distinguish active and completed states. Completed duration is retained beside the summary, matching the source's compact elapsed-time treatment.
- Interaction and accessibility: running work is expanded by default; completed work is collapsed by default; the completed process can be reopened through a semantic button with `aria-expanded`; final answer content remains outside the collapsed region. Final browser console check reported zero errors and zero warnings.

## Comparison history

The first post-implementation comparison found no actionable P0/P1/P2 issue. A P3 fidelity refinement added elapsed time to the completed summary; the revised 1440 × 900 capture was compared again with both source images.

## Primary interactions tested

- Loaded the browser-rendered preview.
- Confirmed the completed process is collapsed while its final answer remains visible.
- Expanded the completed process and confirmed reasoning and grouped tools become visible.
- Confirmed the active process is expanded with live reasoning and tool progress.
- Confirmed no detached right task panel or top-bar task-panel toggle remains.
- Checked 900px and 640px widths for horizontal overflow.
- Checked the final browser console: zero errors and zero warnings.

## Implementation checklist

- [x] Keep thinking, tool calls, intermediate text, and final answer inside one Agent message.
- [x] Preserve real event order instead of forcing a fixed phase order.
- [x] Expand active work and collapse completed work by default.
- [x] Keep the completed final answer visible outside the process collapsible.
- [x] Remove the right task panel and its toggle.
- [x] Verify desktop and narrow layouts in a real browser.

## Follow-up polish

- P3: elapsed time uses compact Latin units (`h`, `m`, `s`) in both locales to match the reference density; localized unit wording can be added later if product language requirements change.

final result: passed
