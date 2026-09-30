// Entry point. Everything it does is wire the pieces together:
//
//   constants.ts  URIs, defaults, protocol literals
//   types.ts      internal domain shapes
//   schema.ts     boundary validation for untrusted payloads
//   mcp.ts        the MCP wire protocol (remote servers)
//   gateway.ts    the YAAR data layer (yaar://mcp, yaar://config/mcp)
//   tools.ts      shared tool-list parsing
//   log.ts        one shape for logging and reporting a failure
//   store.ts      reactive state atoms
//   actions.ts    every mutation, shared by the UI and the protocol
//   protocol.ts   the agent-facing surface
//   ui/           the view
import { defineApp } from '@bundled/yaar';
import { appCommands, appState } from './protocol';
import { App } from './ui/App';
import './styles/index';

export default defineApp({
  id: 'mcp-manager',
  name: 'MCP Manager',
  state: { ...appState },
  commands: { ...appCommands },
  // Every command acts on the server's MCP config, which a remount reads back; replaying
  // one re-scans, re-adds or re-removes a server. New commands inherit this.
  replay: 'never',
  view: App,
});
