import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { addDiscovered } from '../actions';
import { deriveName } from '../mcp';
import { loading } from '../store';
import type { DiscoveredServer } from '../types';
import { ToolList } from './ToolList';

/**
 * What to call a server that did not report a name: the port it answered on if
 * a scan found it, otherwise a name derived from the URL — the same one it
 * would actually be registered under.
 */
function discoveredLabel(server: DiscoveredServer): string {
  if (server.serverName) return server.serverName;
  return server.port != null ? `Port ${server.port}` : deriveName(server.url);
}

/**
 * One not-yet-configured server, from either a scan or a probe. Shared by both
 * sections so a hit looks the same however it was found.
 */
export function DiscoveredCard(server: DiscoveredServer) {
  const toolCount = server.tools.length;
  return html`
    <div class="y-card discovered-card">
      <div class="discovered-row">
        <span class="y-dot y-dot-ok"></span>
        <div class="server-info">
          <strong>${discoveredLabel(server)}</strong>
          <${Show} when=${server.serverVersion}>
            <span class="version">v${server.serverVersion}</span>
          </>
          <${Show} when=${server.protocolVersion}>
            <span class="proto-badge">MCP ${server.protocolVersion}</span>
          </>
          <span class="tool-count">
            ${toolCount} tool${toolCount !== 1 ? 's' : ''}
          </span>
          <span class="server-url">${server.url}</span>
        </div>
        <button
          class="y-btn y-btn-primary y-btn-sm"
          onClick=${() => addDiscovered(server)}
          disabled=${loading}
        >
          Add
        </button>
      </div>
      <${Show} when=${toolCount > 0}>
        ${() => ToolList(() => server.tools)}
      </>
    </div>
  `;
}