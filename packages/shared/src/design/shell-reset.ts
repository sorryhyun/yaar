/**
 * The inline `<style>` block in the desktop shell's `<head>`.
 *
 * It lives here because two packages emit that document: `packages/frontend/build.ts` for
 * production and `packages/server/src/http/dev-bundler.ts` for `make *-dev`. Nothing keeps
 * two copies in sync, and the drift is close to invisible — a rule present in production
 * but missing in dev only shows up when someone happens to perform the gesture it covers,
 * in dev, on a page with an app iframe.
 *
 * The `yaar-dragging` rules are the ones that earn this. A window drag is tracked with
 * document-level `mousemove`, which an app iframe would otherwise swallow the moment the
 * pointer crossed it, stalling the drag; `pointer-events: none` for the duration is what
 * keeps the events coming. The class is put on `<html>` by `useMouseTracking`, which also
 * owns taking it off — including when the window is destroyed mid-drag and no `mouseup`
 * ever arrives.
 */
export const SHELL_RESET_CSS = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body, #root { width: 100%; height: 100%; overflow: hidden; font-family: var(--font-sans); }
      html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
      html.yaar-dragging iframe { pointer-events: none; }
      html.yaar-dragging, html.yaar-dragging * { user-select: none; }`;
