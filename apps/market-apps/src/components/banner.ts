import html from '@bundled/solid-js/html';
import { githubStatus } from '../store/index.js';

/**
 * A warning strip above the header, shown *only* while GitHub is degraded.
 *
 * Publishing writes through GitHub's API, so an outage there fails a publish with
 * an opaque 5xx that reads like a bug in your app. Renders nothing at all when
 * GitHub is healthy — a permanently-visible green light would just train the eye
 * to skip past it on the one day it turns red.
 *
 * Stable outer node + reactive inner content: the strip appears and disappears as
 * `githubStatus` flips without the parent re-rendering. Both dialogs use the same
 * idiom.
 */
export function githubBanner() {
  return html`
    <div>
      ${() => {
        const s = githubStatus();
        if (!s.degraded) return null;
        // One interpolation, not three: `solid-js/html` drops the literal
        // whitespace between two adjacent `${}` expressions, which ran the
        // component name into the severity ("API Requestspartial outage").
        const headline = `GitHub ${s.components.join(' and ')}: ${s.level.replace(/_/g, ' ')}`;
        return html`
          <div class="github-banner" role="status">
            <span class="github-banner-icon">⚠</span>
            <div class="github-banner-body">
              <div>
                <strong>${headline}</strong>
                <span class="y-text-muted"> — publishing may fail until it recovers.</span>
              </div>
              ${s.incident
                ? html`<div class="github-banner-detail y-text-muted y-clamp-2">${s.incident}</div>`
                : ''}
            </div>
            <a
              class="y-btn y-btn-sm y-btn-ghost"
              href="https://www.githubstatus.com"
              target="_blank"
              rel="noreferrer noopener"
              >Details</a
            >
          </div>
        `;
      }}
    </div>
  `;
}