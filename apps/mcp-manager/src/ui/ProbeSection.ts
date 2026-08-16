import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { runProbe } from '../actions';
import { probeInput, probeResult, probing, setProbeInput } from '../store';
import { DiscoveredCard } from './DiscoveredCard';

/**
 * Add-by-URL: probe one address and, if something MCP-shaped answers, offer it
 * as a card. Probing writes nothing to the config — adding is a second click.
 */
export function ProbeSection() {
  return html`
    <section class="section">
      <h2 class="y-label">Add a server by URL</h2>
      <div class="probe-row">
        <input
          class="y-input probe-input"
          type="text"
          placeholder="http://127.0.0.1:3999/mcp"
          value=${probeInput}
          onInput=${(e: InputEvent) => setProbeInput((e.target as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') void runProbe();
          }}
        />
        <button class="y-btn y-btn-primary" onClick=${runProbe} disabled=${probing}>
          ${() => (probing() ? 'Probing...' : 'Probe')}
        </button>
      </div>
      <${Show} when=${probeResult}>
        ${() => DiscoveredCard(probeResult()!)}
      </>
    </section>
  `;
}