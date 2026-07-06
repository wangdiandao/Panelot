/**
 * Brand constants for contexts where the CSS token cascade can't reach —
 * the content script paints overlays inside a shadow root on arbitrary
 * pages. Values MUST mirror src/ui/styles/global.css; change them together.
 *
 * Lives outside src/ui/ on purpose: the content script imports this, and
 * tests/ui/contentIsolation.test.ts forbids it from importing src/ui/**.
 */

/** --primary (light) — element-highlight overlays on web pages. */
export const BRAND_PRIMARY = '#4f46e5';
/** --primary at 25% alpha for the highlight halo. */
export const BRAND_PRIMARY_HALO = 'rgba(79, 70, 229, 0.25)';

/** .dark surface trio for the in-page status badge. */
export const BADGE_BG = '#16161d';
export const BADGE_FG = '#ececf3';
export const BADGE_BORDER = '#2d2d3a';
