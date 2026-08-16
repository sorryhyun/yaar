import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { tryToast } from '@bundled/yaar';
import { startScan } from '../actions';
import {
  scanFrom,
  scanHost,
  scanPath,
  scanProgress,
  scanTo,
  scanning,
  setScanFrom,
  setScanHost,
  setScanPath,
  setScanTo,
  visibleDiscovered,
} from '../store';
import type { DiscoveredServer } from '../types';
import { DiscoveredCard } from './DiscoveredCard';

interface ScanFieldOptions {
  label: string;
  /** Accessor, not a value — the input tracks the signal. */
  value: () => string | number;
  onInput: (raw: string) => void;
  /** 'number' for the port fields. */
  type?: string;
  /** Extra class on the wrapper, for the narrow port columns. */
  modifier?: string;
}

/**
 * One labelled input in the scan row. A plain function, not a component tag:
 * `html` wraps *component* props in reactive getters, which would run `onInput`
 * during render — calling it directly passes the handler through untouched.
 */
function ScanField(opts: ScanFieldOptions) {
  return html`
    <div class=${`scan-field${opts.modifier ? ` ${opts.modifier}` : ''}`}>
      <label class="field-label">${opts.label}</label>
      <input
        class="y-input"
        type=${opts.type ?? 'text'}
        value=${opts.value}
        onInput=${(e: InputEvent) => opts.onInput((e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

/**
 * Port-range discovery. Hits stream into the list as each batch resolves, and
 * anything already configured is filtered out by `visibleDiscovered`.
 */
export function ScanSection() {
  return html`
    <section class="section">
      <h2 class="y-label">Scan for MCP servers</h2>

      <div class="scan-fields">
        ${ScanField({ label: 'Host', value: scanHost, onInput: setScanHost })}
        ${ScanField({
          label: 'From',
          value: scanFrom,
          onInput: (raw) => setScanFrom(Number(raw)),
          type: 'number',
          modifier: 'scan-field-sm',
        })}
        ${ScanField({
          label: 'To',
          value: scanTo,
          onInput: (raw) => setScanTo(Number(raw)),
          type: 'number',
          modifier: 'scan-field-sm',
        })}
        ${ScanField({ label: 'Path', value: scanPath, onInput: setScanPath })}
        <div class="scan-field scan-field-btn">
          <button
            class="y-btn y-btn-primary"
            onClick=${() => tryToast(() => startScan())}
            disabled=${scanning}
          >
            ${() => (scanning() ? 'Scanning...' : 'Scan')}
          </button>
        </div>
      </div>

      <${Show} when=${scanProgress}>
        <div class=${() => (scanning() ? 'scan-progress' : 'scan-done')}>${scanProgress}</div>
      </>

      <${For} each=${visibleDiscovered}>
        ${(server: DiscoveredServer) => DiscoveredCard(server)}
      </>
    </section>
  `;
}