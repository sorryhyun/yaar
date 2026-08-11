import html from '@bundled/solid-js/html';
import { showToast, errMsg } from '@bundled/yaar';
import { saveDataUrl, sharedPath } from '../lib/shared-tree';

/** An image output part (a data URL from show()/plot.toPNG()) plus its save button. */
export function ImageView(props: { src: string }) {
  const save = async () => {
    try {
      const r = await saveDataUrl(props.src, sharedPath(undefined, 'image-' + Date.now()));
      showToast('Saved ' + r.path, 'success', 4000);
    } catch (e) {
      showToast('Save failed: ' + errMsg(e), 'error');
    }
  };
  return html`
    <div class="lab-image-block">
      <img class="lab-image" src=${() => props.src} alt="cell output" />
      <div class="lab-chart-actions"><button class="lab-mini" onClick=${save}>Save to shared/lab</button></div>
    </div>`;
}
