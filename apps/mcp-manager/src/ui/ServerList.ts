import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { confirmRemove, refreshServer, toggleExpand } from '../actions';
import { CONNECTION_STATE } from '../constants';
import { expandedServer, serverTools, servers } from '../store';
import type { McpServer } from '../types';
import { ToolList } from './ToolList';

/** Status dot colour. Anything the gateway does not call live reads as an error. */
function stateDot(state: string): string {
  if (state === CONNECTION_STATE.connected) return 'y-dot y-dot-ok';
  if (state === CONNECTION_STATE.connecting) return 'y-dot y-dot-warn';
  return 'y-dot y-dot-err';
}

/**
 * The configured servers, with live connection state. Rows expand to show the
 * tool list, which is fetched on first expand rather than up front.
 */
export function ServerList() {
  return html`
    <section class="section">
      <div class="section-header">
        <h2 class="y-label">Configured servers</h2>
        <span class="live-hint">live</span>
      </div>

      <${Show} when=${() => servers().length === 0}>
        <div class="y-empty">
          <div class="y-empty-icon">🔌</div>
          No MCP servers configured
        </div>
      </>

      <${For} each=${servers}>
        ${(server: McpServer) => html`
          <div class="y-card server-card">
            <div class="y-list-item server-row" onClick=${() => toggleExpand(server.name)}>
              <span class=${() => stateDot(server.state)}></span>
              <div class="server-info">
                <strong>${server.name}</strong>
                <span class="server-type">${server.type}</span>
                <${Show} when=${server.toolCount != null}>
                  <span class="tool-count">${server.toolCount} tools</span>
                </>
                <${Show} when=${server.error}>
                  <span class="server-error">${server.error}</span>
                </>
              </div>
              <!-- Buttons sit inside the row, so their clicks must not also toggle it. -->
              <div class="server-actions" onClick=${(e: Event) => e.stopPropagation()}>
                <button
                  class="y-btn y-btn-ghost y-btn-sm"
                  onClick=${() => refreshServer(server.name)}
                >Refresh</button>
                <button
                  class="y-btn y-btn-danger y-btn-sm"
                  onClick=${() => confirmRemove(server.name)}
                >Remove</button>
              </div>
            </div>

            <${Show} when=${() => expandedServer() === server.name}>
              <div class="server-tools">
                <${Show}
                  when=${() => (serverTools()[server.name]?.length ?? 0) > 0}
                  fallback=${html`<div class="no-tools">No tools or not connected</div>`}
                >
                  ${() => ToolList(() => serverTools()[server.name] ?? [])}
                </>
              </div>
            </>
          </div>
        `}
      </>
    </section>
  `;
}