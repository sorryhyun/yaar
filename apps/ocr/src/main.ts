// OCR — PP-OCRv6 text recognition running in the app iframe on WebGPU.
//
//   model.ts       weights, PaddleOCR-faithful preprocessing, greedy CTC decode
//   charset.ts     the 18,708-character dictionary, generated from inference.yml
//   recognize.ts   the single funnel UI / protocol / automation all call
//   image-input.ts file picker, drag-drop, paste, data URL
//   sample.ts      generated multi-script test card
//   ui/App.ts      the whole view
//   protocol.ts    what an agent can read and command
//   headless.ts    window.__ocr, for CDP-driven verification
//
// This is the *recognition* stage only — it reads a box you point at, it does not
// find text on a page. Adding PP-OCRv6_*_det is the next step.
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
