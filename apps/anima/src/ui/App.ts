// The whole UI: prompt box, Generate, the Options popover (ratio / seed / weights),
// the progress bar, the status line and the canvas with its image actions.
import { onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { capabilities, clearWeightCache } from '../ml';
import { BUCKETS, bucketById } from '../buckets';
import { TOTAL_BYTES } from '../download';
import { gb } from '../logging';
import { registerProtocol } from '../protocol';
import { generate, batchGenerate } from '../pipeline/generate';
import { downloadModels } from '../pipeline/diagnostics';
import { releaseOtherDits } from '../pipeline/session';
import {
  bucket,
  bucketId,
  busy,
  caps,
  hasImage,
  lastResult,
  progress,
  prompt,
  seed,
  setBucketId,
  setCanvas,
  setCaps,
  setLastResult,
  setPrompt,
  setSeed,
  setShowOptions,
  setStatus,
  showOptions,
  status,
} from '../state';
import { copyImage, publishToMedia, saveImage } from './imageActions';

export function App() {
  let optionsEl: HTMLDivElement | undefined;
  // Close the Options popover on any click outside it (including on the canvas).
  const onDocClick = (e: MouseEvent) => {
    if (!showOptions()) return;
    if (optionsEl && e.target instanceof Node && optionsEl.contains(e.target)) return;
    setShowOptions(false);
  };
  document.addEventListener('click', onDocClick);
  onCleanup(() => document.removeEventListener('click', onDocClick));

  onMount(async () => {
    registerProtocol({
      getStatus: status,
      getBusy: busy,
      getProgress: progress,
      getLastResult: lastResult,
      setLastResult,
      setPrompt,
      setSeed,
      setRatio: setBucketId,
      getCapabilities: caps,
      buckets: BUCKETS,
      generate,
      batchGenerate,
    });
    const c = await capabilities();
    setCaps(
      c.webgpu
        ? `WebGPU ✓  f16=${c.f16}  maxBuffer=${gb(c.maxBufferSize)}  maxStorageBinding=${gb(c.maxStorageBufferBindingSize)}  [${c.adapter ?? 'adapter?'}]`
        : 'WebGPU ✗ — no adapter (wasm-only)',
    );
  });
  return html`
    <div class="y-app anima-root">
      <div class="y-flex" style="align-items: baseline; gap: var(--yaar-sp-3); flex-wrap: wrap;">
        <h2 style="margin:0; font-size: var(--yaar-text-lg);">🌸 Anima — WebGPU probe</h2>
        <div class="y-label">${caps}</div>
      </div>
      <textarea
        class="y-input anima-prompt"
        rows="2"
        placeholder="Describe the image…"
        value=${prompt}
        oninput=${(e: Event) => setPrompt((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="y-flex" style="gap: var(--yaar-sp-2); flex-wrap: wrap; align-items: center;">
        <button class="y-btn y-btn-primary" disabled=${busy} onclick=${() => generate()}>
          ✨ Generate image
        </button>
        <div class="anima-options" ref=${(el: HTMLDivElement) => (optionsEl = el)}>
          <button
            class="y-btn y-btn-ghost"
            title="Options — aspect ratio, seed, weights"
            onclick=${() => setShowOptions((v) => !v)}
          >
            ⚙ Options
          </button>
          <div class="anima-popover" style=${() => `display:${showOptions() ? 'flex' : 'none'};`}>
            <label class="anima-row">
              <span class="y-label">ratio</span>
              <select
                class="y-select"
                disabled=${busy}
                onchange=${(e: Event) => {
                  const v = (e.target as HTMLSelectElement).value;
                  if (v === bucketId()) return;
                  setBucketId(v);
                  // A ratio is a different graph, so it's a different session: drop the old
                  // one's 3.9 GB of GPU memory now rather than holding both.
                  void releaseOtherDits(bucketById(v).dit);
                }}
              >
                ${() =>
                  BUCKETS.map(
                    (b) =>
                      html`<option value=${b.id} selected=${() => bucketId() === b.id}>
                        ${b.label}
                      </option>`,
                  )}
              </select>
            </label>
            <label class="anima-row">
              <span class="y-label">seed</span>
              <input
                class="y-input"
                type="number"
                style="width:90px"
                value=${seed}
                onchange=${(e: Event) => setSeed(Number((e.target as HTMLInputElement).value) | 0)}
              />
            </label>
            <div class="y-divider"></div>
            <button class="y-btn y-btn-ghost" disabled=${busy} onclick=${downloadModels}>
              ⬇ Download weights (${gb(TOTAL_BYTES)})
            </button>
            <button
              class="y-btn y-btn-ghost"
              disabled=${busy}
              onclick=${() => clearWeightCache().then(() => setStatus('🧹 weight cache cleared'))}
            >
              🧹 Clear cache
            </button>
          </div>
        </div>
      </div>
      <div style=${() => `display:${progress() ? 'block' : 'none'};`}>
        <div
          class="y-flex"
          style="justify-content:space-between; align-items:center; margin-bottom:4px;"
        >
          <span class="y-label">${() => progress()?.label ?? ''}</span>
          <span class="y-label">
            ${() => {
              const p = progress();
              return p && p.pct != null ? `${p.pct.toFixed(0)}%` : '';
            }}
          </span>
        </div>
        <div
          style="height:10px; background: var(--yaar-bg-surface); border:1px solid var(--yaar-border); border-radius:5px; overflow:hidden;"
        >
          <div
            style=${() => {
              const pct = progress()?.pct;
              const w = pct == null ? 100 : Math.max(0, Math.min(100, pct));
              return (
                `height:100%; background: var(--yaar-accent); transition:width .15s ease; ` +
                `width:${w}%; opacity:${pct == null ? 0.35 : 1};`
              );
            }}
          ></div>
        </div>
      </div>
      <div class="y-label" style=${() => `display:${status() ? 'block' : 'none'};`}>${status}</div>
      <div class="anima-canvas-wrap">
        <canvas
          ref=${(el: HTMLCanvasElement) => setCanvas(el)}
          width=${() => bucket().W}
          height=${() => bucket().H}
          style=${() =>
            `width:${bucket().W}px; height:${bucket().H}px; max-width:100%; background: var(--yaar-bg-surface); ` +
            `border:1px solid var(--yaar-border); border-radius:6px;`}
        ></canvas>
        <div class="anima-img-actions" style=${() => `display:${hasImage() ? 'flex' : 'none'};`}>
          <button
            class="anima-icon-btn"
            title="Copy image to clipboard"
            disabled=${() => busy() || !hasImage()}
            onclick=${copyImage}
          >
            📋
          </button>
          <button
            class="anima-icon-btn"
            title="Save PNG"
            disabled=${() => busy() || !hasImage()}
            onclick=${saveImage}
          >
            💾
          </button>
          <button
            class="anima-icon-btn"
            title="Publish to shared media (other apps can use it)"
            disabled=${() => busy() || !hasImage()}
            onclick=${publishToMedia}
          >
            🌍
          </button>
        </div>
      </div>
    </div>
  `;
}
