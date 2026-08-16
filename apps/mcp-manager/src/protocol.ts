// The agent-facing protocol: state keys and commands.
//
// Handlers do no work of their own — they call the same actions the UI calls,
// so a command and a click cannot diverge. Kept out of main.ts so the surface
// an agent sees is one file, and a change to it is visible in a diff as such.
//
// Descriptors must stay statically readable for the build to extract them:
// plain `const` object literals, no factories, no computed descriptions. Each
// command is wrapped in `defineAppCommand` so its `params` schema keeps typing
// its own `run` after the spread into `defineApp`.
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';
import {
  addServerByUrl,
  refreshServerByName,
  removeServerByName,
  startScan,
} from './actions';
import { probeUrl } from './mcp';
import {
  serverTools,
  servers,
  setScanFrom,
  setScanHost,
  setScanPath,
  setScanTo,
  visibleDiscovered,
} from './store';

export const appState = {
  servers: {
    description: 'Configured MCP servers with live connection state, type, url and tool count.',
    get: () => servers(),
  },
  discovered: {
    description:
      'MCP servers found by the most recent scan or probe that are not yet configured.',
    get: () => visibleDiscovered(),
  },
};

export const appCommands = {
  scan: defineAppCommand({
    description:
      'Scan a host/port range for MCP servers. Returns servers that are not already configured.',
    params: z.object({
      host: z.optional(z.string()),
      from: z.optional(z.number()),
      to: z.optional(z.number()),
      path: z.optional(z.string()),
    }),
    replay: 'never',
    run: async (p) => {
      // Params double as form input: an agent's scan leaves the fields showing
      // what it scanned, so the user can re-run or adjust it by hand.
      if (p.host !== undefined) setScanHost(p.host);
      if (p.from !== undefined) setScanFrom(p.from);
      if (p.to !== undefined) setScanTo(p.to);
      if (p.path !== undefined) setScanPath(p.path);
      const found = await startScan();
      return {
        found: found.length,
        servers: found.map((s) => ({
          url: s.url,
          name: s.serverName,
          version: s.serverVersion,
          protocolVersion: s.protocolVersion,
          toolCount: s.tools.length,
        })),
      };
    },
  }),

  addServer: defineAppCommand({
    description:
      'Probe an MCP server URL and register it. Fails without adding if nothing MCP-shaped answers.',
    params: z.object({ url: z.string(), name: z.optional(z.string()) }),
    replay: 'never',
    run: async (p) => {
      // Probe first so a bad URL fails loudly instead of landing a dead entry
      // in the config.
      const probed = await probeUrl(p.url);
      if (!probed) throw new Error(`No MCP server responded at ${p.url}`);
      const name = await addServerByUrl(p.url, p.name ?? probed.serverName);
      return {
        name,
        url: p.url,
        protocolVersion: probed.protocolVersion,
        tools: probed.tools.map((t) => t.name),
      };
    },
  }),

  removeServer: defineAppCommand({
    description: 'Unregister a configured MCP server by name.',
    params: z.object({ name: z.string() }),
    replay: 'never',
    run: async (p) => {
      await removeServerByName(p.name);
      return { removed: p.name };
    },
  }),

  refreshServer: defineAppCommand({
    description: 'Force-refresh the tool cache and connection state for one configured server.',
    params: z.object({ name: z.string() }),
    replay: 'never',
    run: async (p) => {
      await refreshServerByName(p.name);
      // Read back after the refresh so the caller gets the state it produced,
      // not the state before it.
      const server = servers().find((s) => s.name === p.name);
      return {
        name: p.name,
        state: server?.state ?? 'unknown',
        toolCount: server?.toolCount,
        tools: (serverTools()[p.name] ?? []).map((t) => t.name),
      };
    },
  }),
};