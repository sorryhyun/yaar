// The YAAR-side data layer: everything that talks to `yaar://mcp` (the gateway
// owning both config and live connections) and `yaar://config/mcp` (the
// persisted server list).
//
// Plain async functions — no signals, no toasts. Failures propagate to the
// caller, so actions.ts decides how each one is shown and this file stays the
// single place the URI shapes and invoke payloads are written down.
import { invoke, list, read, safeParseOr } from '@bundled/yaar';
import * as z from '@bundled/zod';
import {
  CONNECTION_STATE,
  HTTP_TRANSPORT,
  MCP_ACTION,
  MCP_CONFIG_URI,
  MCP_URI,
  serverToolsUri,
} from './constants';
import { logError } from './log';
import { deriveName } from './mcp';
import {
  McpConfigResponse,
  McpServerConfig,
  McpServerStatus,
  McpStatusListResponse,
} from './schema';
import { parseToolList } from './tools';
import type { McpServer, McpTool } from './types';

/**
 * The configured servers, joined with live gateway status.
 *
 * Two reads: config for names/types/urls, runtime status for state/toolCount.
 * Throws if the config is unreadable or malformed — that is not the same as
 * "no servers configured" and the caller must not render it as one.
 */
export async function fetchServers(): Promise<McpServer[]> {
  const [configRaw, statusRaw] = await Promise.all([
    read(MCP_CONFIG_URI),
    list<unknown>(MCP_URI),
  ]);

  // Validate the persisted config at the trust boundary. A missing config
  // (null/undefined) is coerced to `{}` before validating, which always
  // satisfies this loose schema — so `onInvalid` only ever fires for a config
  // that is *present* and malformed, not for a fresh install.
  const configParsed = safeParseOr(McpConfigResponse, configRaw ?? {}, undefined, {
    onInvalid: (issues) => {
      logError('MCP config failed validation', issues);
      throw new Error('Malformed MCP config');
    },
  });
  // Annotated rather than left to `?? {}`: the bare empty-object literal widens
  // the union to `Record<string, McpServerConfig> | {}`, and `Object.entries`
  // over that union yields `unknown` values two calls downstream.
  const configs: Record<string, z.infer<typeof McpServerConfig>> = configParsed?.servers ?? {};

  // The runtime status list crosses the same boundary as the config and gets
  // the same treatment. It is only a *decoration* of the config-derived list,
  // though, so an unreadable status is survivable in a way an unreadable
  // config is not: the row still renders, as "disconnected".
  const statusParsed = safeParseOr(McpStatusListResponse, statusRaw ?? {}, undefined, {
    label: 'mcp-manager:status',
  });
  const statusMap = new Map<string, z.infer<typeof McpServerStatus>>();
  for (const entry of statusParsed?.servers ?? []) {
    const row = safeParseOr(McpServerStatus, entry, undefined, {
      label: 'mcp-manager:status-entry',
    });
    if (!row) continue;
    statusMap.set(row.name, row);
  }

  return Object.entries(configs).map(([name, cfg]) => {
    const status = statusMap.get(name);
    return {
      name,
      type: cfg.type,
      url: cfg.url,
      state: status?.state ?? CONNECTION_STATE.disconnected,
      error: status?.error,
      toolCount: status?.toolCount,
    };
  });
}

/** The tool list one configured server currently advertises. */
export async function fetchTools(name: string): Promise<McpTool[]> {
  const raw = await list<unknown>(serverToolsUri(name));
  return parseToolList(raw ?? {}, `server "${name}"`);
}

/**
 * Register a server, returning the name it was registered under.
 *
 * `action:'add'` writes the config *and* connects in one step; the older path
 * wrote `yaar://config/mcp` then fired a separate 'reload', which left a window
 * where the config and the live gateway disagreed. Only HTTP transport can be
 * registered from here — see agent/SKILL.md.
 */
export async function addServer(url: string, name?: string): Promise<string> {
  const finalName = (name ?? '').trim() || deriveName(url);
  await invoke(MCP_URI, {
    action: MCP_ACTION.add,
    name: finalName,
    config: { type: HTTP_TRANSPORT, url },
  });
  return finalName;
}

/** Unregister a server: drops the config entry and the live connection. */
export async function removeServer(name: string): Promise<void> {
  await invoke(MCP_URI, { action: MCP_ACTION.remove, name });
}

/** Force the gateway to reconnect and re-cache one server's tools. */
export async function refreshServer(name: string): Promise<void> {
  await invoke(MCP_URI, { action: MCP_ACTION.refresh, name });
}