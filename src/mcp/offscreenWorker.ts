let creatingWorker: Promise<void> | null = null;

export async function ensureMcpWorkerDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creatingWorker ??= Promise.resolve(
    chrome.offscreen.createDocument({
      url: 'mcp-worker.html',
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Run browser-safe MCP sessions and background-owned data import validation.',
    }),
  ).finally(() => {
    creatingWorker = null;
  });
  await creatingWorker;
}
