// OCR — PP-OCRv6 text detection and recognition running in the app iframe on WebGPU.
//
//   model.ts       recognizer weights, PaddleOCR-faithful preprocessing, CTC decode
//   charset.ts     the CTC label table, fetched from the model's own inference.yml
//   detect.ts      detector weights, resize policy, image → probability map
//   geometry.ts    probability map → boxes: DB post-processing, pure and unit-tested
//   crop.ts        detected quad → an upright bitmap the recognizer can read
//   pipeline.ts    the page funnel: detect → order → crop → batch-recognize → assemble
//   recognize.ts   the single-box funnel
//   image-input.ts file picker, drag-drop, paste, data URL
//   sample.ts      generated multi-script test card
//   ui/App.ts      the whole view
//   protocol.ts    what an agent can read and command
//   headless.ts    window.__ocr, for CDP-driven verification
//
// Two models, two stages: detection finds the lines, recognition reads each one. They
// are independent — a box drawn by hand skips detection entirely, which is the escape
// hatch when detection misses a line or the script is one it was not trained on.
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { App } from './ui/App';
import { capabilities } from './model';
import { registerProtocol } from './protocol';
import { installHeadlessHook } from './headless';
import { setBackend } from './state';

render(() => html`<${App} />`, document.getElementById('app')!);

registerProtocol();
installHeadlessHook();

// Report the execution provider up front: wasm works but is many times slower,
// and a user watching a 20-second recognition deserves to know why.
void capabilities().then((caps) => {
  if (!caps.webgpu) {
    setBackend('wasm (no WebGPU — slow)');
    return;
  }
  const adapter = caps.adapter ? caps.adapter.split(/[(,]/)[0].trim() : '';
  setBackend(adapter ? `WebGPU · ${adapter}` : 'WebGPU');
});
