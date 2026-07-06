/**
 * Layout tokens — single source of truth for surface dimensions (docs/09 §2).
 * Pattern borrowed from LobeChat's packages/const/layoutTokens.ts: every
 * magic number that two components must agree on lives here, so the sidebar,
 * stream, and composer can never drift apart.
 */

/** Full-page thread sidebar: user-resizable, clamped (OpenWebUI: 220–480). */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 256;
/** Collapsed icon-rail width. */
export const SIDEBAR_RAIL = 48;

/** Center conversation column cap (docs/09 §3.1). */
export const STREAM_MAX_W = 768;

/** Side panel minimum width Chrome allows us to plan for (docs/09 §3.2). */
export const SIDEPANEL_MIN = 360;

/** Icon-button hit areas: side panel gets larger targets (touch-adjacent). */
export const ICON_BTN_FULL = 32;
export const ICON_BTN_PANEL = 36;

/** Composer growth cap as viewport fraction (LibreChat: 45vh). */
export const COMPOSER_MAX_VH = 45;

/** CSS custom property carrying the live sidebar width on <html>. */
export const SIDEBAR_WIDTH_VAR = '--sidebar-width';

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}
