interface FlowNode {
  id: string;
  label: string;
  shape: 'rect' | 'round' | 'diamond';
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export function renderMermaid(id: string, source: string): string {
  const normalized = source.replaceAll('\r\n', '\n').trim();
  if (/^(?:flowchart|graph)\s+/i.test(normalized)) return renderFlowchart(id, normalized);
  if (/^sequenceDiagram\b/i.test(normalized)) return renderSequence(id, normalized);
  throw new Error('Unsupported Mermaid diagram type');
}

function renderFlowchart(id: string, source: string): string {
  const [header = '', ...lines] = source.split('\n');
  const direction = /\b(LR|RL|TB|TD|BT)\b/i.exec(header)?.[1]?.toUpperCase() ?? 'TB';
  const horizontal = direction === 'LR' || direction === 'RL';
  const reversed = direction === 'RL' || direction === 'BT';
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const node = String.raw`([A-Za-z_][\w.-]*)(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?`;
  const edgePattern = new RegExp(
    `^\\s*${node}\\s*(?:-->|---|-.->|==>)\\s*(?:\\|([^|]*)\\|\\s*)?${node}\\s*$`,
  );

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, '');
    if (!line || /^(?:%%|classDef\b|class\b|style\b|linkStyle\b)/i.test(line)) continue;
    const match = edgePattern.exec(line);
    if (match?.[1] && match[6]) {
      const from = flowNode(match[1], match[2], match[3], match[4]);
      const to = flowNode(match[6], match[7], match[8], match[9]);
      nodes.set(from.id, mergeNode(nodes.get(from.id), from));
      nodes.set(to.id, mergeNode(nodes.get(to.id), to));
      edges.push({ from: from.id, to: to.id, label: match[5]?.trim() || undefined });
      continue;
    }
    const single = new RegExp(`^\\s*${node}\\s*$`).exec(line);
    if (single?.[1]) {
      const parsed = flowNode(single[1], single[2], single[3], single[4]);
      nodes.set(parsed.id, mergeNode(nodes.get(parsed.id), parsed));
    }
  }
  if (nodes.size === 0) throw new Error('Flowchart has no supported nodes');

  const ordered = [...nodes.values()];
  if (reversed) ordered.reverse();
  const spacing = horizontal ? { x: 180, y: 90 } : { x: 170, y: 110 };
  const positions = new Map<string, { x: number; y: number }>();
  ordered.forEach((entry, index) => {
    positions.set(
      entry.id,
      horizontal ? { x: 80 + index * spacing.x, y: 70 } : { x: 100, y: 60 + index * spacing.y },
    );
  });
  const width = horizontal ? Math.max(220, 160 + (ordered.length - 1) * spacing.x) : 220;
  const height = horizontal ? 150 : Math.max(150, 120 + (ordered.length - 1) * spacing.y);
  const markerId = `arrow-${safeId(id)}`;

  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + (horizontal ? 65 : 0);
      const y1 = from.y + (horizontal ? 0 : 28);
      const x2 = to.x - (horizontal ? 65 : 0);
      const y2 = to.y - (horizontal ? 0 : 28);
      const label = edge.label
        ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">${xml(edge.label)}</text>`
        : '';
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${markerId})"/>${label}`;
    })
    .join('');

  const nodeSvg = ordered
    .map((entry) => {
      const position = positions.get(entry.id);
      if (!position) return '';
      const label = `<text x="${position.x}" y="${position.y + 4}" text-anchor="middle">${xml(entry.label)}</text>`;
      if (entry.shape === 'diamond') {
        return `<polygon points="${position.x},${position.y - 38} ${position.x + 68},${position.y} ${position.x},${position.y + 38} ${position.x - 68},${position.y}"/>${label}`;
      }
      return `<rect x="${position.x - 66}" y="${position.y - 28}" width="132" height="56" rx="${entry.shape === 'round' ? 28 : 8}"/>${label}`;
    })
    .join('');

  return svgShell(width, height, markerId, edgeSvg + nodeSvg, 'Flowchart');
}

function renderSequence(id: string, source: string): string {
  const lines = source.split('\n').slice(1);
  const participants = new Map<string, string>();
  const messages: { from: string; to: string; label: string; dashed: boolean }[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;
    const participant = /^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (participant?.[1]) {
      participants.set(participant[1], participant[2]?.trim() || participant[1]);
      continue;
    }
    const message = /^([\w.-]+)\s*(--?>>?|->>?|--x|->x)\s*([\w.-]+)\s*:\s*(.+)$/.exec(line);
    if (message?.[1] && message[2] && message[3] && message[4]) {
      participants.set(message[1], participants.get(message[1]) ?? message[1]);
      participants.set(message[3], participants.get(message[3]) ?? message[3]);
      messages.push({
        from: message[1],
        to: message[3],
        label: message[4].trim(),
        dashed: message[2].startsWith('--'),
      });
    }
  }
  if (participants.size === 0) throw new Error('Sequence diagram has no participants');
  const ordered = [...participants.entries()];
  const width = Math.max(320, ordered.length * 180);
  const height = Math.max(180, 120 + messages.length * 70);
  const x = new Map(ordered.map(([key], index) => [key, 90 + index * 180]));
  const markerId = `arrow-${safeId(id)}`;
  const actors = ordered
    .map(([key, label]) => {
      const center = x.get(key);
      if (center === undefined) return '';
      return `<rect x="${center - 65}" y="20" width="130" height="38" rx="6"/><text x="${center}" y="44" text-anchor="middle">${xml(label)}</text><line class="lifeline" x1="${center}" y1="58" x2="${center}" y2="${height - 20}"/>`;
    })
    .join('');
  const arrows = messages
    .map((message, index) => {
      const from = x.get(message.from);
      const to = x.get(message.to);
      if (from === undefined || to === undefined) return '';
      const y = 95 + index * 70;
      return `<text x="${(from + to) / 2}" y="${y - 9}" text-anchor="middle">${xml(message.label)}</text><line${message.dashed ? ' class="dashed"' : ''} x1="${from}" y1="${y}" x2="${to}" y2="${y}" marker-end="url(#${markerId})"/>`;
    })
    .join('');
  return svgShell(width, height, markerId, actors + arrows, 'Sequence diagram');
}

function flowNode(id: string, rect?: string, round?: string, diamond?: string): FlowNode {
  return {
    id,
    label: (rect ?? round ?? diamond ?? id).trim(),
    shape: diamond !== undefined ? 'diamond' : round !== undefined ? 'round' : 'rect',
  };
}

function mergeNode(previous: FlowNode | undefined, next: FlowNode): FlowNode {
  return previous && next.label === next.id ? previous : next;
}

function svgShell(
  width: number,
  height: number,
  markerId: string,
  body: string,
  label: string,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}" class="panelot-diagram"><defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><style>rect,polygon{fill:var(--muted);stroke:var(--border);stroke-width:1.5}line{stroke:var(--foreground);stroke-width:1.5}.lifeline{stroke:var(--muted-foreground);stroke-dasharray:5 5}.dashed{stroke-dasharray:7 5}text{fill:var(--foreground);font:12px ui-sans-serif,system-ui,sans-serif}marker path{fill:var(--foreground)}</style>${body}</svg>`;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
