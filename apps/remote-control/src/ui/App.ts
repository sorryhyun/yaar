import { For, Show, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { subscribe } from '@bundled/yaar';
import { copyLink, openLink, pressEnter, refreshStatus, toggle } from '../actions';
import { PERMISSION_MODES, REMOTE_CONTROL_URI, type PermissionMode } from '../gateway';
import {
  busy,
  lastError,
  permissionMode,
  reattach,
  running,
  sessionName,
  setPermissionMode,
  setReattach,
  setSessionName,
  status,
} from '../store';

/**
 * The host pings its URI on start, on the link appearing, on exit and on terminal output,
 * so the window follows it without polling. `subscribe` resolves after mount, hence the
 * `disposed` flag.
 */
function watchHost(): void {
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
  if (!s?.running) return s?.state === 'exited' ? `Off (exited ${s.exitCode ?? '?'})` : 'Off';
  if (s.state === 'ready') return `On · monitor ${s.monitorId}`;
  return `Starting · monitor ${s.monitorId}`;
}

function dotClass(): string {
  const s = status();
  if (!s?.running) return 'y-dot';
  return s.state === 'ready' ? 'y-dot y-dot-ok' : 'y-dot y-dot-warn y-dot-pulse';
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
      <label class="rc-field">
        <span class="y-label">Permission mode</span>
        <select
          class="y-select"
          value=${permissionMode}
          onChange=${(e: Event) =>
            setPermissionMode((e.target as HTMLSelectElement).value as PermissionMode)}
        >
          <${For} each=${PERMISSION_MODES}>
            ${(mode: string) => html`<option value=${mode}>${mode}</option>`}
          </>
        </select>
      </label>
      <label class="rc-check">
        <input
          type="checkbox"
          checked=${reattach}
          onChange=${(e: Event) => setReattach((e.target as HTMLInputElement).checked)}
        />
        <span>Reattach to the last session</span>
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
        Or open claude.ai/code or the Claude app and pick this machine's environment.
      </p>
    </div>
  `;
}

export function App() {
  onMount(() => {
    void refreshStatus();
    watchHost();
  });

  return html`
    <div class="y-app rc-app">
      <header class="rc-header">
        <div class="rc-title">
          <strong>Claude Remote Control</strong>
          <span class="rc-sub">
            Drive this monitor from claude.ai/code or the Claude app, as its monitor agent.
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
          Remote Control is running on monitor ${() => status()?.monitorId}, not this one. Only one
          host runs at a time — turn it off to start it here.
        </div>
      </>

      <${Show} when=${lastError}>
        <div class="y-card y-wash-error rc-banner">${lastError}</div>
      </>

      <${Show} when=${() => !running()}>${Options}</>

      <${Show} when=${() => running() && status()?.sessionUrl}>${LinkCard}</>

      <${Show} when=${() => running() && status()?.state === 'starting'}>
        <div class="y-card rc-banner">
          Waiting for the link. If the terminal below is asking something, answer it.
          <button class="y-btn y-btn-sm" onClick=${() => void pressEnter()}>Press Enter</button>
        </div>
      </>

      <${Show} when=${() => status()?.tail}>
        <details class="rc-terminal" open=${() => status()?.state === 'starting'}>
          <summary class="y-label">Terminal</summary>
          <pre>${() => status()?.tail}</pre>
        </details>
      </>
    </div>
  `;
}
