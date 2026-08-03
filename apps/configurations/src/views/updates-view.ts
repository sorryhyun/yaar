import { createSignal, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { read, invoke, errMsg } from '@bundled/yaar';
import { showToast } from '../store';
import type { UpdateStatus } from '../types';

/**
 * Version display and self-update.
 *
 * The server owns every decision here — whether this build can update itself, which
 * release asset it needs, whether the download matched the published checksum. This
 * view only renders `yaar://system/update` and calls two actions on it, so a rule
 * about updating never has to be true in two places.
 *
 * Polling rather than subscribing: `read` on that URI is deliberately network-free,
 * so a 1s poll while an install runs costs nothing upstream, and the poll stops the
 * moment the install reaches a terminal stage.
 */

const POLL_MS = 1000;

/** Stages during which the installer is still working. */
const ACTIVE_STAGES = ['downloading', 'verifying', 'installing'];

const BLOCKED_HINTS: Record<string, string> = {
  'source-checkout':
    'You are running YAAR from a source checkout. Update it with `git pull && bun install` — there is no binary here to replace.',
  'unsupported-platform':
    'No release binary is published for this platform. Build from source to update.',
  'no-asset':
    'The latest release does not publish a build for this platform. Grab one from the releases page.',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** First few lines of the release body — the full notes live behind the release link. */
function summarizeNotes(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return '';
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

export function UpdatesView() {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [loadError, setLoadError] = createSignal('');

  let timer: ReturnType<typeof setInterval> | undefined;

  const busy = () => {
    const stage = status()?.progress?.stage;
    return !!stage && ACTIVE_STAGES.includes(stage);
  };

  const stopPolling = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const poll = async () => {
    try {
      const next = await read<UpdateStatus>('yaar://system/update');
      setStatus(next);
      if (!ACTIVE_STAGES.includes(next?.progress?.stage ?? '')) stopPolling();
    } catch (err) {
      // A poll that fails is not worth a toast on every tick — the button state and
      // the last-known status stay put, and the next tick may well succeed.
      console.error('[configurations] update poll failed', err);
      stopPolling();
    }
  };

  const startPolling = () => {
    stopPolling();
    timer = setInterval(poll, POLL_MS);
  };

  const check = async (force: boolean) => {
    setChecking(true);
    try {
      const next = await invoke<UpdateStatus>('yaar://system/update', { action: 'check', force });
      setStatus(next);
      setLoadError('');
      if (force) {
        if (next.checkError) showToast(next.checkError, 'error');
        else if (next.latest?.updateAvailable) showToast(`Version ${next.latest.version} is available`);
        else showToast('YAAR is up to date');
      }
    } catch (err) {
      console.error('[configurations] update check failed', err);
      setLoadError(errMsg(err));
      if (force) showToast(`Update check failed: ${errMsg(err)}`, 'error');
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setStarting(true);
    try {
      const next = await invoke<UpdateStatus>('yaar://system/update', { action: 'install' });
      setStatus(next);
      startPolling();
    } catch (err) {
      // The server refuses synchronously when there is nothing to install or this
      // build cannot install it, so this message is the actual reason, not a timeout.
      showToast(errMsg(err), 'error');
    } finally {
      setStarting(false);
    }
  };

  onMount(async () => {
    // Read first so the current version paints immediately, then check the network.
    try {
      const initial = await read<UpdateStatus>('yaar://system/update');
      setStatus(initial);
      if (ACTIVE_STAGES.includes(initial?.progress?.stage ?? '')) startPolling();
    } catch (err) {
      console.error('[configurations] failed to read yaar://system/update', err);
      setLoadError(errMsg(err));
    }
    await check(false);
  });

  onCleanup(stopPolling);

  const Progress = () => {
    const p = status()?.progress;
    if (!p) return '';
    if (p.stage === 'ready') {
      return html`
        <div class="u-banner u-banner-ok">
          <strong>Update installed.</strong>
          <span>${p.detail ?? 'Restart YAAR to run the new version.'}</span>
        </div>
      `;
    }
    if (p.stage === 'error') {
      return html`
        <div class="u-banner u-banner-err">
          <strong>Update failed.</strong>
          <span>${p.error ?? 'Unknown error.'}</span>
        </div>
      `;
    }
    if (!ACTIVE_STAGES.includes(p.stage)) return '';

    const pct = typeof p.fraction === 'number' ? Math.round(p.fraction * 100) : null;
    return html`
      <div class="u-progress">
        <div class="u-progress-head">
          <span>${() => `${p.stage}${p.detail ? ` — ${p.detail}` : ''}`}</span>
          <span>${() => (pct === null ? '' : `${pct}%`)}</span>
        </div>
        <div class=${() => `y-progress${pct === null ? ' y-progress-indeterminate' : ''}`}>
          <div
            class="y-progress-fill"
            style=${() => (pct === null ? '' : `width: ${pct}%`)}
          ></div>
        </div>
      </div>
    `;
  };

  const Latest = () => {
    const s = status();
    if (!s) return '';
    if (s.checkError) {
      return html`<div class="u-banner u-banner-err"><span>${s.checkError}</span></div>`;
    }
    if (!s.latest) return html`<p class="s-hint-block">No release information yet.</p>`;

    if (!s.latest.updateAvailable) {
      return html`
        <div class="u-banner u-banner-ok">
          <span>You are on the latest version (${s.latest.version}).</span>
        </div>
      `;
    }

    const notes = summarizeNotes(s.latest.notes);
    return html`
      <div class="u-release">
        <div class="u-release-head">
          <div>
            <div class="u-release-title">${s.latest.name}</div>
            <div class="s-hint">
              ${s.current} → ${s.latest.version}${formatDate(s.latest.publishedAt) ? ` · ${formatDate(s.latest.publishedAt)}` : ''}
            </div>
          </div>
          <a class="y-btn y-btn-ghost" href=${s.latest.url} target="_blank" rel="noreferrer">
            Release notes ↗
          </a>
        </div>
        ${notes ? html`<pre class="u-notes">${notes}</pre>` : ''}
      </div>
    `;
  };

  const Blocked = () => {
    const s = status();
    if (!s || s.canInstall || !s.blockedReason) return '';
    return html`
      <div class="u-banner u-banner-warn">
        <span>${BLOCKED_HINTS[s.blockedReason] ?? 'This build cannot install updates.'}</span>
      </div>
    `;
  };

  return html`
    <div class="settings-wrapper">
      <div class="s-section">
        <div class="y-label s-section-title">📦 Version</div>
        ${() =>
          loadError()
            ? html`<div class="u-banner u-banner-err"><span>${loadError()}</span></div>`
            : ''}
        <div class="s-row">
          <label class="s-label">Running</label>
          <div class="u-value">${() => status()?.current ?? '…'}</div>
        </div>
        <div class="s-row">
          <label class="s-label">Build</label>
          <div class="u-value">
            ${() => {
              const s = status();
              if (!s) return '…';
              const shape = s.bundled ? 'standalone executable' : 'source checkout';
              return `${shape} · ${s.platform}/${s.arch}`;
            }}
          </div>
        </div>
      </div>

      <div class="s-section">
        <div class="y-label s-section-title">⬆️ Updates</div>
        ${Latest}
        ${Blocked}
        ${Progress}
        <div class="u-actions">
          <button class="y-btn" onClick=${() => check(true)} disabled=${() => checking() || busy()}>
            ${() => (checking() ? 'Checking…' : 'Check for updates')}
          </button>
          ${() => {
            const s = status();
            if (!s?.latest?.updateAvailable || !s.canInstall) return '';
            if (s.progress.stage === 'ready') return '';
            return html`
              <button
                class="y-btn y-btn-primary"
                onClick=${install}
                disabled=${() => starting() || busy()}
              >
                ${() => (busy() ? 'Installing…' : `Install ${s.latest?.version}`)}
              </button>
            `;
          }}
        </div>
        <p class="s-hint-block">
          Downloads are verified against the release's published
          <code>SHA256SUMS</code> before anything is replaced. Installing does not restart
          YAAR — quit and start it again to run the new version.
        </p>
      </div>
    </div>
  `;
}
