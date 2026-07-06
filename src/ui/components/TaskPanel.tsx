/**
 * TaskPanel — full-page right column (docs/09 §3.1).
 * Simplified (2026-07-05): shows only the planning task list and the
 * agent-touched tab audit trail. The panel is collapsed by default and opens
 * automatically when the agent writes to the todo list (/plan flow) or the
 * user toggles it.
 */

import { t } from '../i18n';
import type { ThreadUiState } from '../engineClient';

export function TaskPanel({ state }: { state: ThreadUiState }) {
  const { todos, agentTabs, queuedInputs } = state;
  const hasContent = todos.length > 0 || agentTabs.length > 0;

  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-l border-border-soft bg-card p-4">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
        {t('app.taskPanel')}
      </div>

      {/* Planning task list — the primary reason this panel opens. */}
      {todos.length > 0 ? (
        <div className="space-y-1.5 text-[13px]">
          {todos.map((todo, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 ${todo.done ? 'text-faint-foreground' : ''}`}
            >
              <span className={`mt-0.5 shrink-0 text-[11px] ${todo.done ? 'text-success' : 'text-faint-foreground'}`}>
                {todo.done ? '✓' : '○'}
              </span>
              <span className={todo.done ? 'line-through' : ''}>{todo.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-faint-foreground">{t('app.noTasks')}</div>
      )}

      {/* Agent-touched tabs — audit trail; lets the user see & jump to them. */}
      {agentTabs.length > 0 && (
        <div className="mt-4 space-y-1">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
            {t('app.agentTabs')}
          </div>
          {agentTabs.map((tab) => (
            <button
              key={tab.tabId}
              type="button"
              onClick={() => void chrome.tabs.update(tab.tabId, { active: true })}
              className="block w-full truncate text-left text-[12px] text-muted-foreground hover:text-foreground"
              title={tab.url}
            >
              {tab.title || tab.url} ↗
            </button>
          ))}
        </div>
      )}

      {queuedInputs > 0 && (
        <div className="mt-3 text-[12px] text-muted-foreground">
          {t('app.queued', { n: queuedInputs })}
        </div>
      )}

      {!hasContent && queuedInputs === 0 && (
        <div className="mt-2 text-[11px] text-faint-foreground">{t('app.taskPanelHint')}</div>
      )}
    </aside>
  );
}
