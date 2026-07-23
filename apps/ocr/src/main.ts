// OCR — PP-OCRv6 text detection and recognition running in the app iframe on WebGPU.
//
//   engine/        model runtime, detection, geometry, crops, arbitration, and weights
//   workflows/     model warming plus single-region and whole-page OCR funnels
//   input/         file/paste/drop loading, generated sample image, and window capture
//   ui/App.ts      the whole view
//   state.ts       reactive state shared by the UI, protocol, and workflows
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
import { capabilities } from './engine/model';
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
