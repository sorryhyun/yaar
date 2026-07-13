import html from '@bundled/solid-js/html';
import type { Label, GHUser } from '../types';
import { contrastText } from '../utils';

export function labelChips(labels: Label[]) {
  if (!labels || labels.length === 0) return null;
  return html`<span class="label-row">${labels.map((l) => html`
    <span class="gh-label" style=${`background:#${l.color || '888'};color:${contrastText('#' + (l.color || '888888'))}`}>${l.name}</span>
  `)}</span>`;
}

export function avatar(user: GHUser | null | undefined, size = 20) {
  if (!user?.avatar_url) return null;
  return html`<img class="avatar" src=${user.avatar_url} width=${size} height=${size} alt=${user.login || ''} />`;
}

export function loadingBlock(label = 'Loading…') {
  return html`<div class="y-empty"><span class="y-spinner y-spinner-lg"></span><span>${label}</span></div>`;
}

export function emptyBlock(icon: string, label: string) {
  return html`<div class="y-empty"><span class="y-empty-icon">${icon}</span><span>${label}</span></div>`;
}

export function errorBlock(msg: string, onRetry?: () => void) {
  return html`<div class="y-empty">
    <span class="y-empty-icon">⚠️</span>
    <span class="y-text-error">${msg}</span>
    ${onRetry ? html`<button class="y-btn y-btn-sm" onClick=${onRetry}>Retry</button>` : null}
  </div>`;
}

/**
 * Render pre-sanitized markdown HTML into a div.
 *
 * NOTE: must be `innerHTML=${...}`, NOT lit-html's `.innerHTML=${...}`. Solid's
 * `html` tag does not support the leading-dot property form — it parses `.innerHTML`
 * as a literal attribute named `.innerhtml` and stringifies the HTML into it, so the
 * node renders completely empty. That silently blanked every markdown body in the app.
 */
export function mdBody(getHtml: () => string) {
  return html`<div class="md-body" innerHTML=${getHtml}></div>`;
}
