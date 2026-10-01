import { For, Show, createEffect, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { formatBytes, formatDuration, showConfirm } from '@bundled/yaar';
import { stopStream } from '@bundled/yaar-media';
import {
  captureUrl,
  deleteCapture,
  flipCamera,
  refreshCaptures,
  reporting,
  startCamera,
  stopCamera,
  takePhoto,
  toggleRecording,
} from '../actions';
import {
  busy,
  captures,
  facing,
  lastError,
  recProgress,
  recording,
  setViewing,
  setWithAudio,
  stream,
  viewing,
  withAudio,
  type Capture,
} from '../store';

function Preview() {
  let video: HTMLVideoElement | undefined;
  // srcObject is a property, not an attribute — set it whenever the stream changes.
  createEffect(() => {
    const s = stream();
    if (video) video.srcObject = s;
  });
  return html`
    <div class="cam-stage">
      <video
        ref=${(el: HTMLVideoElement) => (video = el)}
        class=${() => `cam-video${facing() === 'user' ? ' mirrored' : ''}`}
        autoplay
        muted
        playsinline
      ></video>
      <${Show} when=${() => !stream()}>
        <div class="cam-off">
          <span>Camera is off</span>
          <button class="y-btn y-btn-primary" disabled=${busy} onClick=${reporting(() => startCamera())}>
            Open camera
          </button>
        </div>
      </>
      <${Show} when=${recording}>
        <div class="cam-rec">
          <span class="y-dot y-dot-err y-dot-pulse"></span>
          <span>${() => formatDuration(recProgress().durationMs / 1000)}</span>
          <span class="cam-rec-bytes">${() => formatBytes(recProgress().bytes)} saved</span>
        </div>
      </>
    </div>
  `;
}

function Viewer(props: { capture: Capture }) {
  return html`
    <div class="cam-stage">
      <${Show}
        when=${() => props.capture.kind === 'video'}
        fallback=${() => html`<img class="cam-video" src=${() => captureUrl(props.capture)} />`}
      >
        <video class="cam-video" src=${() => captureUrl(props.capture)} controls playsinline></video>
      </>
      <button class="y-btn y-btn-sm cam-back" onClick=${() => setViewing(null)}>← Live</button>
    </div>
  `;
}

function Controls() {
  const live = () => stream() !== null;
  return html`
    <div class="cam-controls">
      <button
        class="y-btn"
        disabled=${() => !live() || !!recording() || busy()}
        onClick=${reporting(flipCamera)}
        title="Switch camera"
      >
        ⟲ ${() => (facing() === 'environment' ? 'Back' : 'Front')}
      </button>
      <button
        class="y-btn"
        disabled=${() => !live()}
        onClick=${reporting(takePhoto)}
      >
        Photo
      </button>
      <button
        class=${() => `y-btn cam-rec-btn${recording() ? ' y-btn-danger' : ' y-btn-primary'}`}
        disabled=${() => !live()}
        onClick=${() => void toggleRecording()}
      >
        ${() => (recording() ? '■ Stop' : '● Record')}
      </button>
      <label class="cam-audio">
        <input
          type="checkbox"
          checked=${withAudio}
          disabled=${() => !!recording()}
          onChange=${(e: Event) => {
            setWithAudio((e.target as HTMLInputElement).checked);
            if (stream()) void startCamera().catch(() => {});
          }}
        />
        Audio
      </label>
      <${Show} when=${live}>
        <button class="y-btn y-btn-ghost" onClick=${reporting(stopCamera)}>Off</button>
      </>
    </div>
  `;
}

function CaptureList() {
  const remove = async (c: Capture) => {
    if (!(await showConfirm(`Delete ${c.path}?`, { danger: true, okLabel: 'Delete' }))) return;
    await deleteCapture(c.path);
    if (viewing()?.path === c.path) setViewing(null);
  };
  return html`
    <div class="cam-list">
      <${Show} when=${() => captures().length === 0}>
        <div class="cam-empty">No captures yet.</div>
      </>
      <${For} each=${captures}>
        ${(c: Capture) => html`
          <div
            class=${() => `y-list-item cam-item${viewing()?.path === c.path ? ' active' : ''}`}
            onClick=${() => setViewing(c)}
          >
            <span>${c.kind === 'video' ? '🎬' : '🖼️'}</span>
            <span class="cam-item-name">${c.path.replace(/^captures\//, '')}</span>
            <span class="cam-item-size">${formatBytes(c.size)}</span>
            <button
              class="y-btn y-btn-ghost y-btn-sm"
              onClick=${(e: Event) => {
                e.stopPropagation();
                void remove(c);
              }}
            >
              ✕
            </button>
          </div>
        `}
      </>
    </div>
  `;
}

export function App() {
  onMount(() => void refreshCaptures());
  // A closed window must not leave the camera light on.
  onCleanup(() => stopStream(stream()));

  return html`
    <div class="y-app cam-app">
      <${Show} when=${viewing} fallback=${Preview} keyed=${true}>
        ${(c: Capture) => Viewer({ capture: c })}
      </>
      <${Controls} />
      <${Show} when=${lastError}>
        <div class="y-card y-wash-error cam-banner">${lastError}</div>
      </>
      <${CaptureList} />
    </div>
  `;
}
