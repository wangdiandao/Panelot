const APPROVAL_FOCUS_SELECTOR = '[data-approval-focus-target="true"]';

export function focusLatestApproval(doc: Document = document): boolean {
  const targets = doc.querySelectorAll<HTMLElement>(APPROVAL_FOCUS_SELECTOR);
  const target = targets.item(targets.length - 1);
  if (!target) return false;
  if (!target.contains(doc.activeElement)) target.focus();
  return true;
}

export function handoffMenuCloseToApproval(event: { preventDefault(): void }): boolean {
  if (!focusLatestApproval()) return false;
  event.preventDefault();
  return true;
}
