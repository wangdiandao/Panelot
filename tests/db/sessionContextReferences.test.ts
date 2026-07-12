import { describe, expect, it } from 'vitest';
import { userMessageToUnifiedMessage } from '../../src/db/sessionContext';

describe('referenced context model contract', () => {
  it('labels tabs, Skills, and MCP resources with their source metadata', () => {
    const message = userMessageToUnifiedMessage({
      content: [{ type: 'text', text: 'Use these.' }],
      attachedContext: [
        {
          kind: 'tab',
          label: 'Issue 42',
          sourceRef: '42',
          origin: 'https://example.com/issues/42',
          provenance: 'page',
          content: [{ type: 'text', text: 'tab body' }],
        },
        {
          kind: 'skill',
          label: 'review-pr',
          sourceRef: 'skill-1',
          trust: 'trusted',
          provenance: 'user',
          content: [{ type: 'text', text: 'skill body' }],
        },
        {
          kind: 'mcp_resource',
          label: 'Repository guide',
          sourceRef: 'github://guide',
          provenance: 'mcp',
          content: [{ type: 'text', text: 'resource body' }],
        },
      ],
    });
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('[Panelot context: kind=tab label="Issue 42" source="42"');
    expect(text).toContain('[Panelot context: kind=skill label="review-pr" source="skill-1"]');
    expect(text).toContain(
      '[Panelot context: kind=mcp_resource label="Repository guide" source="github://guide"]',
    );
    expect(text).toContain('<<<web_content_');
  });
});
