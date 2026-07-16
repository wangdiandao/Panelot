import type { InteractionRequestPayload, InteractionResponse } from '../messaging/protocol';
import type { BrowserToolGateway } from '../tools/gateway';

const ALARM_PREFIX = 'panelot-interaction:';

interface AutomationTarget {
  threadId: string;
  interactionId: string;
  request: Extract<InteractionRequestPayload, { kind: 'watch_page' | 'schedule' }>;
}

export class InteractionAutomation {
  private active = new Map<string, AbortController>();
  private targets = new Map<string, AutomationTarget>();

  constructor(
    private readonly gateway: BrowserToolGateway,
    private readonly resolve: (
      interactionId: string,
      response: InteractionResponse,
    ) => Promise<void>,
  ) {}

  handle(threadId: string, interactionId: string, request: InteractionRequestPayload): void {
    if (request.kind !== 'watch_page' && request.kind !== 'schedule') return;
    this.clear(interactionId);
    const abort = new AbortController();
    this.active.set(interactionId, abort);
    this.targets.set(interactionId, { threadId, interactionId, request });
    const when = request.kind === 'schedule' ? request.resumeAt : request.deadlineAt;
    chrome.alarms.create(`${ALARM_PREFIX}${interactionId}`, { when });
    if (request.kind === 'schedule') return;
    if (request.condition.type === 'url') {
      this.runWatcher(this.watchUrl(interactionId, request, abort.signal));
      return;
    }
    if (request.condition.type === 'download') {
      this.runWatcher(
        this.watchDownload(interactionId, request.condition.downloadId, abort.signal),
      );
      return;
    }
    this.runWatcher(this.watchText(threadId, interactionId, request, abort.signal));
  }

  private runWatcher(watcher: Promise<void>): void {
    void watcher.catch(() => undefined);
  }

  private isActive(interactionId: string, signal: AbortSignal): boolean {
    return !signal.aborted && this.active.get(interactionId)?.signal === signal;
  }

  clear(interactionId: string): void {
    this.active.get(interactionId)?.abort();
    this.active.delete(interactionId);
    this.targets.delete(interactionId);
    void chrome.alarms.clear(`${ALARM_PREFIX}${interactionId}`).catch(() => undefined);
  }

  handleAlarm(name: string): boolean {
    if (!name.startsWith(ALARM_PREFIX)) return false;
    const interactionId = name.slice(ALARM_PREFIX.length);
    const target = this.targets.get(interactionId);
    if (!target) return true;
    const response: InteractionResponse =
      target.request.kind === 'schedule'
        ? { kind: 'submit', value: { resumedAt: Date.now(), reason: target.request.reason } }
        : { kind: 'timeout', value: { deadlineAt: target.request.deadlineAt } };
    void this.resolve(interactionId, response).catch(() => {
      if (this.targets.get(interactionId) === target) {
        chrome.alarms.create(`${ALARM_PREFIX}${interactionId}`, { when: Date.now() + 60_000 });
      }
    });
    return true;
  }

  private async watchUrl(
    interactionId: string,
    request: Extract<InteractionRequestPayload, { kind: 'watch_page' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const initialTab = await chrome.tabs.get(request.tabId);
    if (
      initialTab.url?.includes('value' in request.condition ? request.condition.value : '') &&
      this.isActive(interactionId, signal)
    ) {
      await this.resolve(interactionId, {
        kind: 'submit',
        value: { matched: true, url: initialTab.url },
      });
      return;
    }
    if (!this.isActive(interactionId, signal)) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const listener = (tabId: number, changeInfo: { url?: string }) => {
        if (
          tabId === request.tabId &&
          changeInfo.url?.includes('value' in request.condition ? request.condition.value : '')
        ) {
          finish();
        }
      };
      const onAbort = () => finish();
      chrome.tabs.onUpdated.addListener(listener);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (!this.isActive(interactionId, signal)) return;
    const matchedTab = await chrome.tabs.get(request.tabId);
    if (!this.isActive(interactionId, signal)) return;
    await this.resolve(interactionId, {
      kind: 'submit',
      value: { matched: true, url: matchedTab.url },
    });
  }

  private async watchDownload(
    interactionId: string,
    downloadId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (signal.aborted) return;
    if (download?.state === 'complete') {
      await this.resolve(interactionId, { kind: 'submit', value: { downloadId, completed: true } });
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(listener);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          finish();
        }
      };
      const onAbort = () => finish();
      chrome.downloads.onChanged.addListener(listener);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (!signal.aborted) {
      await this.resolve(interactionId, { kind: 'submit', value: { downloadId, completed: true } });
    }
  }

  private async watchText(
    threadId: string,
    interactionId: string,
    request: Extract<InteractionRequestPayload, { kind: 'watch_page' }>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && Date.now() < request.deadlineAt) {
      const condition = request.condition;
      if (condition.type !== 'text' && condition.type !== 'text_gone') return;
      try {
        await this.gateway.callContentTool(
          threadId,
          'wait_for',
          condition.type === 'text' ? { text: condition.value } : { textGone: condition.value },
          request.tabId,
          signal,
          Math.min(request.deadlineAt, Date.now() + 30_000),
        );
        if (!signal.aborted) {
          await this.resolve(interactionId, {
            kind: 'submit',
            value: { matched: true, condition },
          });
        }
        return;
      } catch {
        if (signal.aborted || Date.now() >= request.deadlineAt) return;
      }
    }
  }
}
