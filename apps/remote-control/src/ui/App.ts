import { Show, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { subscribe } from '@bundled/yaar';
import { copyLink, openLink, refreshStatus, toggle } from '../actions';
import { REMOTE_CONTROL_URI } from '../gateway';
import { busy, lastError, running, sessionName, setSessionName, status } from '../store';

/**
 * The server pings the URI on start and stop, so the window follows it without polling.
 * `subscribe` resolves after mount, hence the `disposed` flag.
 */
function watchRemote(): void {
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  subscribe(REMOTE_CONTROL_URI, () => void refreshStatus())
    .then((fn) => {
      if (disposed) fn();
      else unsubscribe = fn;
    })
    .catch((err) => console.error('[remote-control] subscription failed', err));
  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
  });
}

/** `start` returns a status without `callerMonitorId`, so this can briefly be unknown. */
function elsewhere(): boolean {
  const s = status();
  return !!s?.running && s.callerMonitorId != null && s.monitorId !== s.callerMonitorId;
}

function stateLabel(): string {
  const s = status();
  return s?.running ? `On · monitor ${s.monitorId}` : 'Off';
}

function dotClass(): string {
  return status()?.running ? 'y-dot y-dot-ok' : 'y-dot';
}

function Options() {
  return html`
    <div class="rc-options">
      <label class="rc-field">
        <span class="y-label">Session name</span>
        <input
          class="y-input"
          placeholder="optional"
          value=${sessionName}
          onInput=${(e: Event) => setSessionName((e.target as HTMLInputElement).value)}
        />
      </label>
    </div>
  `;
}

function LinkCard() {
  const url = () => status()?.sessionUrl ?? '';
  return html`
    <div class="y-card rc-link">
      <span class="y-label">Session link</span>
      <code class="rc-url">${url}</code>
      <div class="rc-link-actions">
        <button class="y-btn y-btn-primary" onClick=${() => openLink(url())}>Open</button>
        <button class="y-btn" onClick=${() => void copyLink(url())}>Copy</button>
      </div>
      <p class="rc-note">
        The same conversation as this monitor's agent: what you ask there, it does here.
      </p>
    </div>
  `;
}

export function App() {
  onMount(() => {
    void refreshStatus();
    watchRemote();
  });

  return html`
    <div class="y-app rc-app">
      <header class="rc-header">
        <div class="rc-title">
          <strong>Claude Remote Control</strong>
          <span class="rc-sub">
            Talk to this monitor's agent from claude.ai/code or the Claude app.
          </span>
        </div>
        <button
          class=${() => `rc-switch${running() ? ' on' : ''}`}
          role="switch"
          aria-checked=${() => String(running())}
          disabled=${busy}
          onClick=${() => void toggle()}
        >
          <span class="rc-knob"></span>
        </button>
      </header>

      <div class="rc-state">
        <span class=${dotClass}></span>
        <span>${stateLabel}</span>
        <${Show} when=${busy}><span class="y-spinner"></span></>
      </div>

      <${Show} when=${elsewhere}>
        <div class="y-card y-wash-warning rc-banner">
          Remote Control is on for monitor ${() => status()?.monitorId}, not this one. Only one
          monitor at a time — turn it off to start it here.
        </div>
      </>

      <${Show} when=${lastError}>
        <div class="y-card y-wash-error rc-banner">${lastError}</div>
      </>

      <${Show} when=${() => !running()}>${Options}</>

      <${Show} when=${() => running() && status()?.sessionUrl}>${LinkCard}</>

    </div>
  `;
}
