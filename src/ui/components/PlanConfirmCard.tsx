/**
 * PlanConfirmCard — shown instead of the normal composer when the agent has
 * finished writing a plan (todos.length > 0, agent turn complete, planMode=true).
 *
 * Replaces manual "type confirm" with two explicit choices:
 *  • 确认并执行 — sends the confirm message, exits plan mode
 *  • 调整后执行 — drops back to the textarea so the user can edit instructions
 *  • 放弃计划   — exits plan mode without executing
 *
 * The todo list is shown inline so the user reviews what they are confirming.
 */

import { Check, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { t } from '../i18n';

interface TodoItem {
  text: string;
  done: boolean;
}

interface Props {
  todos: TodoItem[];
  onConfirm: () => void;
  onEdit: () => void;
  onCancel: () => void;
}

export function PlanConfirmCard({ todos, onConfirm, onEdit, onCancel }: Props) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-info/40 bg-info/5">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-info/20">
          <Check className="size-3 text-info" />
        </div>
        <span className="flex-1 text-[13px] font-medium">{t('plan.ready')}</span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-faint-foreground hover:text-foreground"
          aria-label={expanded ? t('plan.collapse') : t('plan.expand')}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>

      {/* Todo list (collapsible) */}
      {expanded && todos.length > 0 && (
        <div className="border-t border-info/20 px-4 py-2">
          <ol className="space-y-1.5">
            {todos.map((todo, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="mt-0.5 shrink-0 text-[11px] font-mono text-faint-foreground">{i + 1}.</span>
                <span className={todo.done ? 'text-faint-foreground line-through' : ''}>{todo.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Action row */}
      <div className="flex gap-2 border-t border-info/20 px-4 py-3">
        <Button
          size="sm"
          className="flex-1 gap-1.5"
          onClick={onConfirm}
        >
          <Check className="size-3.5" />
          {t('plan.confirm')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
          {t('plan.edit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          onClick={onCancel}
        >
          <X className="size-3.5" />
          {t('plan.cancel')}
        </Button>
      </div>
    </div>
  );
}
