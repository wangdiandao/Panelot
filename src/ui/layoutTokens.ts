/**
 * Layout tokens shared across components (docs/09 §2). Only dimensions that
 * two files must agree on live here (pattern from LobeChat's layoutTokens);
 * single-consumer sizes stay as Tailwind classes at the point of use.
 */

/** Full-page thread sidebar: user-resizable, clamped (OpenWebUI: 220–480). */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 256;
/** Collapsed icon-rail width. */
export const SIDEBAR_RAIL = 48;

/** Center conversation column cap (docs/09 §3.1). */
export const STREAM_MAX_W = 768;

/** CSS custom property carrying the live sidebar width on <html>. */
export const SIDEBAR_WIDTH_VAR = '--sidebar-width';

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}
