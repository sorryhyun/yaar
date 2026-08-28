/**
 * The window's markup, in four pieces rather than one 133-line template.
 *
 * The pieces are plain functions called during `App()`, not Solid components: every
 * reactive read stays inside the same `${() => ...}` accessor it was in before, so
 * the split changes where the markup is written and nothing about when it updates.
 */
import html from '@bundled/solid-js/html';
import {
  lock,
  loading,
  showScreenshot,
  placeholderText,
  currentUrl,
  pageTitle,
  activeBrowserId,
} from './store';
import {
  liveMode,
  liveStatus,
  liveStats,
  quality,
  type QualityPreset,
  setCanvasEl,
  syncViewport,
  onCanvasMouseDown,
  onCanvasMouseUp,
  onCanvasMouseMove,
  onCanvasWheel,
  onCanvasContextMenu,
  onCanvasKeyDown,
  onCanvasKeyUp,
  onCanvasPaste,
  setImeAnchorEl,
  imeStatus,
  onImeStart,
  onImeUpdate,
  onImeEnd,
  onImeInput,
  liveTabs,
  switchLiveTab,
  closeLiveTab,
  type LiveTab,
} from './live';
import { setScreenshotEl } from './dom';
import { handleNav, handleReload, handleUrlFocus, handleUrlKeydown } from './actions';
import { toggleLive, changeQuality } from './session';
import {
  adBlockEnabled,
  blockedCount,
  currentSiteExempt,
  toggleAdBlock,
  toggleSiteException,
} from './adblock';

/** What a tab calls itself in the strip: its title, else its host, else its id. */
function tabLabel(tab: LiveTab): string {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).host;
  } catch {
    return `browser:${tab.browserId}`;
  }
}

function UrlBar() {
  return html`
    <div class="url-bar y-flex y-gap-2 y-px-2 y-surface y-border-b">
      <button
        class="y-btn y-btn-sm y-btn-ghost"
        title="Back"
        aria-label="Back"
        onClick=${() => handleNav('navigate_back')}
      >
        ←
      </button>
      <button
        class="y-btn y-btn-sm y-btn-ghost"
        title="Forward"
        aria-label="Forward"
        onClick=${() => handleNav('navigate_forward')}
      >
        →
      </button>
      <span class=${() => lock().cls}>${() => lock().icon}</span>
      <input
        class="url-text y-input"
        value=${() => currentUrl()}
        onFocus=${handleUrlFocus}
        onKeydown=${handleUrlKeydown}
      />
      <button
        class="y-btn y-btn-sm y-btn-ghost"
        title="Reload"
        aria-label="Reload"
        onClick=${handleReload}
      >
        ↻
      </button>
      <button
        class=${() => `y-btn y-btn-sm ${liveMode() ? 'y-btn-primary' : 'y-btn-ghost'}`}
        title="Live mode — stream the page and drive it yourself"
        aria-pressed=${() => String(liveMode())}
        onClick=${() => void toggleLive()}
      >
        ◉ Live
      </button>
      ${ShieldToggle()} ${() => (liveMode() ? QualitySelect() : null)}
      <span class="title-text y-text-xs y-text-muted y-truncate">${() => pageTitle()}</span>
    </div>
  `;
}

/**
 * The shield: click flips the global switch, alt-click exempts this site.
 *
 * Two switches on one control because the toolbar is already seven items wide and
 * a second button would be there for a case that is rare — most sites are never
 * excepted. The tooltip carries the alt-click, and the exempt state is visible
 * (a dimmed shield) rather than something to go looking for.
 */
function shieldState(): { cls: string; label: string } {
  if (!adBlockEnabled()) return { cls: 'y-btn-ghost off', label: 'off' };
  if (currentSiteExempt()) return { cls: 'y-btn-ghost exempt', label: 'off for this site' };
  return { cls: 'y-btn-primary', label: 'on' };
}

function ShieldToggle() {
  return html`
    <button
      class=${() => `y-btn y-btn-sm shield ${shieldState().cls}`}
      title=${() =>
        `Ad & popup blocking: ${shieldState().label}. Click to toggle, Alt+click for this site only.`}
      aria-pressed=${() => String(adBlockEnabled() && !currentSiteExempt())}
      onClick=${(e: MouseEvent) => void (e.altKey ? toggleSiteException() : toggleAdBlock())}
    >
      🛡<span class="shield-badge"
        >${() => (blockedCount() > 0 ? String(blockedCount()) : '')}</span
      >
    </button>
  `;
}

function QualitySelect() {
  return html`
    <select
      class="y-select quality-select"
      title="Stream quality"
      value=${() => quality()}
      onChange=${(e: Event) =>
        changeQuality((e.target as HTMLSelectElement).value as QualityPreset)}
    >
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
  `;
}

/**
 * Only shown once there is more than one tab. A popup is what usually creates
 * the second one, and a strip that is always there would be chrome charging
 * rent for the case that hasn't happened yet.
 */
function TabStrip() {
  return html`
    <div class="tab-strip y-flex y-gap-1 y-px-2 y-surface y-border-b">
      ${() =>
        liveTabs().map(
          (tab: LiveTab) => html`
            <div class=${() => `live-tab ${activeBrowserId() === tab.browserId ? 'active' : ''}`}>
              <button
                class="y-btn y-btn-sm y-btn-ghost tab-label y-truncate"
                title=${() => tab.url || `browser:${tab.browserId}`}
                onClick=${() => switchLiveTab(tab.browserId)}
              >
                ${() => tabLabel(tab)}
              </button>
              <button
                class="y-btn y-btn-sm y-btn-ghost tab-close"
                title="Close tab"
                aria-label="Close tab"
                onClick=${() => void closeLiveTab(tab.browserId)}
              >
                ×
              </button>
            </div>
          `,
        )}
    </div>
  `;
}

/** The spike's instrument panel — see the header of live.ts for what each number means. */
function LiveStatsBar() {
  return html`
    <div class="live-stats y-text-xs">
      <span>${() => liveStatus()}</span>
      <span>${() => `${liveStats().fps} fps`}</span>
      <span>${() => `${liveStats().lagMs} ms`}</span>
      <span>${() => `${liveStats().kbps} kbps`}</span>
      <span>${() => `${liveStats().dropped} dropped`}</span>
      <span class="ime-readout">${() => imeStatus()}</span>
    </div>
  `;
}

/** The page itself: the still screenshot, the live canvas, and the IME anchor over it. */
function Stage() {
  return html`
    <div class="screenshot-area">
      <div class="loading-track">
        <div class=${() => (loading() ? 'loading-bar active' : 'loading-bar')}></div>
      </div>
      ${() =>
        !liveMode() && !showScreenshot()
          ? html` <div class="placeholder y-text-muted y-text-sm">${() => placeholderText()}</div> `
          : null}
      <img
        ref=${(el: HTMLImageElement) => {
          setScreenshotEl(el);
        }}
        style=${() => (!liveMode() && showScreenshot() ? '' : 'display:none')}
        alt="Browser screenshot"
      />
      <canvas
        class="live-canvas"
        tabindex="0"
        ref=${(el: HTMLCanvasElement) => {
          setCanvasEl(el);
          // The remote page reflows to whatever the human's window actually is,
          // which is also what makes the remote-mode reading (a phone) honest.
          new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box && liveMode()) syncViewport(box.width, box.height);
          }).observe(el.parentElement ?? el);
        }}
        style=${() => (liveMode() ? '' : 'display:none')}
        onMouseDown=${onCanvasMouseDown}
        onMouseUp=${onCanvasMouseUp}
        onMouseMove=${onCanvasMouseMove}
        onWheel=${onCanvasWheel}
        onContextMenu=${onCanvasContextMenu}
      ></canvas>
      <!--
        The IME anchor: hidden, unclickable, and the thing that actually owns the
        keyboard while live. It exists because an IME cannot compose into a canvas
        and because the OS draws its candidate window at *this* element's caret —
        so live/ime.ts keeps moving it onto the remote page's caret.
      -->
      <textarea
        class="ime-anchor"
        ref=${(el: HTMLTextAreaElement) => {
          setImeAnchorEl(el);
        }}
        style=${() => (liveMode() ? '' : 'display:none')}
        aria-hidden="true"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        onKeyDown=${onCanvasKeyDown}
        onKeyUp=${onCanvasKeyUp}
        onPaste=${onCanvasPaste}
        onCompositionStart=${onImeStart}
        onCompositionUpdate=${onImeUpdate}
        onCompositionEnd=${onImeEnd}
        onInput=${onImeInput}
      ></textarea>
      ${() => (liveMode() ? LiveStatsBar() : null)}
    </div>
  `;
}

export function App() {
  return html`
    <div class="browser-chrome y-app">
      ${UrlBar()} ${() => (liveMode() && liveTabs().length > 1 ? TabStrip() : null)} ${Stage()}
    </div>
  `;
}
