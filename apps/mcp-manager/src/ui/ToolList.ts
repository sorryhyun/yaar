import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import type { McpTool } from '../types';

/**
 * The tool rows shown under a discovered card or an expanded server.
 *
 * Takes an accessor rather than an array so the caller can hand over a
 * store-backed getter and have the list track it. Called as a plain function
 * (`${() => ToolList(...)}`), not mounted as a component — it has no state and
 * no lifecycle of its own.
 */
export function ToolList(tools: () => McpTool[]) {
  return html`
    <ul class="tool-list">
      <${For} each=${tools}>
        ${(tool: McpTool) => html`
          <li class="tool-item">
            <span class="tool-name">${tool.name}</span>
            <${Show} when=${tool.description}>
              <span class="tool-desc">${tool.description}</span>
            </>
          </li>
        `}
      </>
    </ul>
  `;
}