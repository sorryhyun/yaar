import type { EditorState } from './types';
import { formatTime } from './utils/time';

export interface EditorUI {
  root: HTMLDivElement;
  urlInput: HTMLInputElement;
  loadUrlButton: HTMLButtonElement;
  pickFileButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  video: HTMLVideoElement;
  startRange: HTMLInputElement;
  endRange: HTMLInputElement;
  startInput: HTMLInputElement;
  endInput: HTMLInputElement;
  loopButton: HTMLButtonElement;
  timeLabel: HTMLDivElement;
  durationLabel: HTMLDivElement;
  errorLabel: HTMLDivElement;
}

export function createEditorUI(parent: HTMLElement): EditorUI {
  parent.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
    :root {
      color-scheme: light;
      font-family: "Segoe UI", Tahoma, sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: linear-gradient(145deg, #eef5f4, #dfe7eb);
      color: #1f2c3b;
    }

    .editor-shell {
      max-width: 920px;
      margin: 0 auto;
      padding: 20px;
      display: grid;
      gap: 14px;
    }

    .panel {
      background: rgba(255, 255, 255, 0.9);
      border-radius: 12px;
      border: 1px solid #c7d6de;
      padding: 14px;
    }

    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }

    .row > * {
      flex: 1;
      min-width: 150px;
    }

    label {
      font-size: 12px;
      font-weight: 600;
      display: block;
      margin-bottom: 4px;
      color: #334f63;
    }

    input, button {
      width: 100%;
      border: 1px solid #b8c9d1;
      border-radius: 8px;
      padding: 8px 10px;
      background: #fff;
      color: #13222d;
    }

    button {
      cursor: pointer;
      font-weight: 600;
      background: #e7eff2;
    }

    button:hover {
      background: #d9e7ed;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .video-wrap {
      position: relative;
      border-radius: 10px;
      overflow: hidden;
      background: #0f1115;
      min-height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    video {
      width: 100%;
      max-height: 440px;
      background: #111;
    }

    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .chip {
      padding: 8px 10px;
      border-radius: 999px;
      background: #eff6f9;
      border: 1px solid #c8d9e1;
      font-size: 13px;
      font-weight: 600;
    }

    .error {
      color: #9f1f1f;
      font-size: 13px;
      min-height: 18px;
    }

    @media (max-width: 700px) {
      .editor-shell {
        padding: 12px;
      }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'editor-shell';

  const sourcePanel = document.createElement('section');
  sourcePanel.className = 'panel';
  sourcePanel.innerHTML = `
    <div class="row">
      <div style="flex:2; min-width: 240px;">
        <label>Video URL</label>
        <input id="video-url" type="url" placeholder="https://example.com/video.mp4" />
      </div>
      <div style="min-width: 120px;">
        <label>&nbsp;</label>
        <button id="load-url">Load URL</button>
      </div>
      <div style="min-width: 120px;">
        <label>&nbsp;</label>
        <button id="pick-file">Pick Local File</button>
      </div>
    </div>
  `;

  const previewPanel = document.createElement('section');
  previewPanel.className = 'panel';
  previewPanel.innerHTML = `
    <div class="video-wrap">
      <video id="preview" controls preload="metadata"></video>
    </div>
  `;

  const trimPanel = document.createElement('section');
  trimPanel.className = 'panel';
  trimPanel.innerHTML = `
    <div class="row">
      <div>
        <label>Trim Start (sec)</label>
        <input id="start-input" type="number" min="0" step="0.01" value="0" />
      </div>
      <div>
        <label>Trim End (sec)</label>
        <input id="end-input" type="number" min="0" step="0.01" value="0" />
      </div>
      <div style="min-width: 160px;">
        <label>&nbsp;</label>
        <button id="loop-preview" disabled>Play Trimmed Segment</button>
      </div>
    </div>
    <div class="row" style="margin-top: 10px;">
      <div>
        <label>Start Slider</label>
        <input id="start-range" type="range" min="0" max="0" step="0.01" value="0" />
      </div>
      <div>
        <label>End Slider</label>
        <input id="end-range" type="range" min="0" max="0" step="0.01" value="0" />
      </div>
    </div>
    <div class="stats" style="margin-top:10px;">
      <div id="time-label" class="chip">Current: 00:00.00</div>
      <div id="duration-label" class="chip">Selected: 00:00.00</div>
    </div>
    <div id="error" class="error"></div>
  `;

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  fileInput.style.display = 'none';

  root.append(sourcePanel, previewPanel, trimPanel, fileInput);
  parent.appendChild(root);

  const urlInput = root.querySelector<HTMLInputElement>('#video-url')!;
  const loadUrlButton = root.querySelector<HTMLButtonElement>('#load-url')!;
  const pickFileButton = root.querySelector<HTMLButtonElement>('#pick-file')!;
  const video = root.querySelector<HTMLVideoElement>('#preview')!;
  const startRange = root.querySelector<HTMLInputElement>('#start-range')!;
  const endRange = root.querySelector<HTMLInputElement>('#end-range')!;
  const startInput = root.querySelector<HTMLInputElement>('#start-input')!;
  const endInput = root.querySelector<HTMLInputElement>('#end-input')!;
  const loopButton = root.querySelector<HTMLButtonElement>('#loop-preview')!;
  const timeLabel = root.querySelector<HTMLDivElement>('#time-label')!;
  const durationLabel = root.querySelector<HTMLDivElement>('#duration-label')!;
  const errorLabel = root.querySelector<HTMLDivElement>('#error')!;

  return {
    root,
    urlInput,
    loadUrlButton,
    pickFileButton,
    fileInput,
    video,
    startRange,
    endRange,
    startInput,
    endInput,
    loopButton,
    timeLabel,
    durationLabel,
    errorLabel,
  };
}

export function renderEditor(ui: EditorUI, state: EditorState): void {
  const hasSource = Boolean(state.sourceValue);
  const hasDuration = state.duration > 0;
  const selectedDuration = Math.max(0, state.trimEnd - state.trimStart);

  const max = String(state.duration || 0);
  ui.startRange.max = max;
  ui.endRange.max = max;

  ui.startRange.value = String(state.trimStart);
  ui.endRange.value = String(state.trimEnd);
  ui.startInput.value = state.trimStart.toFixed(2);
  ui.endInput.value = state.trimEnd.toFixed(2);

  ui.loopButton.disabled = !hasDuration || Boolean(state.error);
  ui.loopButton.textContent = state.loopPreview ? 'Stop Loop Preview' : 'Play Trimmed Segment';

  ui.timeLabel.textContent = `Current: ${formatTime(state.currentTime)}`;
  ui.durationLabel.textContent = `Selected: ${formatTime(selectedDuration)}`;
  ui.errorLabel.textContent = state.error ?? '';

  ui.video.style.opacity = hasSource ? '1' : '0.6';
  if (!hasDuration) {
    ui.durationLabel.textContent = 'Selected: 00:00.00';
  }
}
