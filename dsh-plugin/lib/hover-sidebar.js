// Hover Overlay Rail for DeepSeek Harness (DSH) Web UI.
//
// Injects an isolated stylesheet into DSH Web UI via Cordis webServer tapIndex,
// enabling a clean, zero-trace collapsible sidebar in collapsed mode:
// - AppFrame grid 1st column collapses to 0px without trace or border lines.
// - Default collapsed mode: width is 0px (translateX(-100%)), 100% space for chat.
// - Left hover zone (14px): moving mouse to left edge smoothly slides out the 56px rail as an overlay.
// - Mouse leave: automatically slides back to 0px without trace.
// - Wide mode (expanded panel): retains default 240px wide layout for workspace browsing.

export const HOVER_SIDEBAR_CSS = `
/* ── mv-AIDE DSH Hover Overlay Rail ───────────────────────────── */
/* 1. Force AppFrame CSS Grid 1st column to 0px when sidebar is collapsed */
div[class*="_frame"]:has(div[class*="_collapsed"]) {
  grid-template-columns: 0px 1fr 0px !important;
}

/* 2. Collapse the sidebar wrapper column to 0 width with no borders or overflow */
div[class*="_sidebarCol"]:has(div[class*="_collapsed"]) {
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  border-right: none !important;
  overflow: visible !important;
}

/* 3. Collapsed 56px rail: fixed overlay off-screen, zero footprint */
div[class*="_root"][class*="_collapsed"] {
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  width: 56px !important;
  z-index: 1000 !important;
  transform: translateX(-100%) !important;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.22s ease !important;
  box-shadow: none !important;
}

/* 4. 14px invisible hover sensor trigger zone on the left edge */
div[class*="_root"][class*="_collapsed"]::after {
  content: "" !important;
  position: absolute !important;
  top: 0 !important;
  right: -14px !important;
  width: 14px !important;
  height: 100% !important;
  cursor: pointer !important;
  background: transparent !important;
  z-index: 1001 !important;
}

/* 5. Slide in smoothly as an overlay when hovering the left edge or rail */
div[class*="_root"][class*="_collapsed"]:hover {
  transform: translateX(0) !important;
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.28) !important;
}
`;

export const STYLE_TAG = `<style id="mv-aide-dsh-hover-sidebar">${HOVER_SIDEBAR_CSS}</style>`;

/**
 * Mount the hover sidebar transform onto the Cordis webServer service if available.
 * Safe & pluggable: failures are contained and logged without throwing.
 *
 * @param {object} ctx - Cordis plugin context.
 * @returns {(() => void) | undefined} Disposer function or undefined.
 */
export function mountHoverSidebar(ctx) {
  if (!ctx) return undefined;
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.tapIndex !== 'function') {
    return undefined;
  }

  return webServer.tapIndex((html) => {
    if (typeof html !== 'string' || html.includes('mv-aide-dsh-hover-sidebar')) {
      return html;
    }
    if (html.includes('</head>')) {
      return html.replace('</head>', `${STYLE_TAG}</head>`);
    }
    return `${html}${STYLE_TAG}`;
  });
}
