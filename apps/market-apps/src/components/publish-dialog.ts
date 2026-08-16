// The publish confirmation dialog and the publisher agreement inside it.

import html from '@bundled/solid-js/html';
import { formatBytes } from '@bundled/yaar';
import { cancelPublish, confirmPublish } from '../actions/index.js';
import { confirmBusy, pendingPublish, setTermsAgreed, termsAgreed } from '../store/index.js';
import type { PreparedPublication, PublisherTerms } from '../types.js';
import { onBackdropClick, targetChecked } from './ui.js';

/**
 * The publisher-agreement block inside the publish dialog.
 *
 * Two shapes, and the difference matters: a publisher who has already accepted this
 * version sees a one-line reminder with the terms still readable, while one who has
 * not gets the checkbox that arms the Publish button. The full text ships inside a
 * `<details>` rather than behind a link — the terms are what the host will hold them
 * to, and reading them must not depend on a network round trip.
 */
function termsBlock(terms: PublisherTerms) {
  const readable = html`<details class="publish-terms-details">
    <summary class="publish-terms-summary y-text-muted">
      Read the Publisher Terms (v${terms.version})
    </summary>
    <pre class="publish-terms-text">${terms.text}</pre>
  </details>`;

  if (terms.accepted) {
    return html`<div class="publish-terms">
      <div class="publish-terms-accepted y-text-muted">
        ✓ You have accepted the Publisher Terms (v${terms.version}).
      </div>
      ${readable}
    </div>`;
  }

  return html`<div class="publish-terms">
    <label class="publish-terms-agree">
      <input
        type="checkbox"
        checked=${() => termsAgreed()}
        disabled=${() => confirmBusy()}
        onChange=${(e: Event) => setTermsAgreed(targetChecked(e))}
      />
      <span>I agree to the Marketplace Publisher Terms (v${terms.version})</span>
    </label>
    ${readable}
  </div>`;
}

/** The frozen artifact the user is approving: version, digest, size. */
function publishMeta(summary: PreparedPublication) {
  return html`
    <dl class="publish-meta">
      <div class="publish-meta-row">
        <dt class="y-text-muted">Version</dt>
        <dd>${summary.version ?? '(none)'}</dd>
      </div>
      <div class="publish-meta-row">
        <dt class="y-text-muted">Artifact</dt>
        <dd class="publish-digest">sha256:${summary.artifactSha256.slice(0, 12)}…</dd>
      </div>
      <div class="publish-meta-row">
        <dt class="y-text-muted">Size</dt>
        <dd>${formatBytes(summary.byteLength)}</dd>
      </div>
    </dl>
  `;
}

/** The drift warning: what changed since the freeze, and what "Publish anyway" ships. */
function driftWarning(files: string[]) {
  return html`<div class="publish-drift" role="alert">
    <div class="publish-drift-head">⚠ Source changed since prepare</div>
    <div class="y-text-muted">
      "Publish anyway" uploads the frozen snapshot you prepared — not these newer
      edits. Cancel and publish again to include them.
    </div>
    <ul class="publish-drift-files">
      ${(files.length ? files : ['(changed-file list unavailable)']).map(
        (f) => html`<li class="publish-digest">${f}</li>`,
      )}
    </ul>
  </div>`;
}

/**
 * The publish confirmation dialog. Stable outer node + reactive inner content (the
 * `githubBanner` idiom), so it shows/hides as `pendingPublish` flips without the
 * parent re-rendering. Shows the frozen digest + size the user is approving, the
 * publisher agreement that arms the button, and on source drift, the changed-file
 * list behind a "Publish anyway" press.
 */
export function publishModal() {
  return html`
    <div>
      ${() => {
        const pending = pendingPublish();
        if (!pending) return null;
        const { app, summary } = pending;
        const drifted = !!pending.drift;
        const files = pending.drift?.changedFiles ?? [];
        const terms = summary.terms;
        // Only an unaccepted agreement gates the button; an already-accepted one is
        // shown for reference and asks nothing.
        const needsTerms = !!terms && !terms.accepted;
        return html`
          <div
            class="publish-backdrop"
            onClick=${onBackdropClick(() => {
              // Click the dim area (not the card) to cancel.
              if (!confirmBusy()) void cancelPublish();
            })}
          >
            <div class="publish-modal y-surface" role="dialog" aria-modal="true">
              <div class="publish-modal-title">Publish ${app.name}</div>
              ${publishMeta(summary)}
              ${drifted ? driftWarning(files) : ''}
              ${terms ? termsBlock(terms) : ''}
              <div class="publish-actions">
                <button
                  class="y-btn y-btn-sm"
                  disabled=${() => confirmBusy()}
                  onClick=${() => void cancelPublish()}
                >
                  Cancel
                </button>
                <button
                  class="y-btn y-btn-sm y-btn-primary"
                  disabled=${() => confirmBusy() || (needsTerms && !termsAgreed())}
                  title=${() =>
                    needsTerms && !termsAgreed()
                      ? 'Accept the Publisher Terms to enable publishing'
                      : ''}
                  onClick=${() => void confirmPublish(drifted)}
                >
                  ${() => (confirmBusy() ? 'Publishing…' : drifted ? 'Publish anyway' : 'Publish')}
                </button>
              </div>
            </div>
          </div>
        `;
      }}
    </div>
  `;
}
