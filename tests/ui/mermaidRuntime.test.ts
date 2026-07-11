import { describe, expect, it } from 'vitest';
import { renderMermaid } from '../../src/ui/mermaidRuntime';

describe('renderMermaid', () => {
  it('renders a safe flowchart without preserving raw HTML', () => {
    const svg = renderMermaid('flow', 'flowchart LR\nA[Start] --> B{<script>alert(1)</script>}');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Start');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
  });

  it('renders sequence participants and messages', () => {
    const svg = renderMermaid(
      'sequence',
      'sequenceDiagram\nparticipant U as User\nparticipant P as Panelot\nU->>P: Run task',
    );
    expect(svg).toContain('User');
    expect(svg).toContain('Panelot');
    expect(svg).toContain('Run task');
  });

  it('rejects unsupported diagram types so the UI can show source', () => {
    expect(() => renderMermaid('unsupported', 'gantt\ntitle Roadmap')).toThrow(/Unsupported/);
  });
});
