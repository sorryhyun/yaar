// Anima WebGPU toy — in-browser text→image on WebGPU. The work itself lives in:
//
//   state.ts            signals shared by UI / pipeline / protocol, + the canvas ref
//   logging.ts          console log, progress-bar bridge, tensor stat summaries
//   pipeline/session.ts DiT session options + eviction of other DiT variants
//   pipeline/generate.ts  the ✨ pipeline: prompt → embeds → randn latent → ER-SDE
//                       4-step denoise over the DiT → denorm → VAE decode → canvas
//   pipeline/diagnostics.ts  vaeProbe / ditGate / ditProbe + weight download
//   ui/App.ts           the whole view; ui/imageActions.ts  copy & save PNG
//   headless.ts         window.__anima, the CDP/automation surface
//
// Lower-level modules are unchanged: ml.ts (ORT sessions), scheduler.ts (ER-SDE),
// text.ts + tokenizer.ts (Qwen3/T5 text path), buckets.ts (aspect-ratio graphs),
// download.ts (weight prefetch), appfiles.ts (app storage), protocol.ts.
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { App } from './ui/App';
import { installHeadlessHook } from './headless';

render(() => html`<${App} />`, document.getElementById('app')!);

installHeadlessHook();
