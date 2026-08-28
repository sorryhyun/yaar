export * from './actions.js';
export * from './events/index.js';
export * from './app-protocol.js';

// The Component DSL and the extension bridge both carry Zod schemas. The barrel exposes only
// their Zod-free half — value lists, narrow types, guards — plus type-only re-exports of what
// the schemas infer. The schemas themselves live behind `@yaar/shared/schemas`, so importing
// this barrel from the browser does not bundle Zod. See `schemas.ts`.
export * from './component-types.js';
export type { ComponentLayout, DisplayContent } from './components.js';
export type {
  BridgeTab,
  BridgeHello,
  BridgeTabs,
  BridgeCommandAction,
  BridgeCommand,
  BridgeContent,
  BridgeCommandResult,
  BridgeActivity,
  BridgeEventChannel,
  BridgeEvent,
  BridgeMessage,
  BridgeServerMessage,
  BridgeFidelity,
} from './bridge.js';

export * from './session.js';
export * from './agent-kind.js';

// Neither module below imports Zod (directly or transitively) — confirmed before switching
// these from hand-maintained named lists to `export *`, so this stays Zod-free like the rest
// of the barrel.
export * from './iframe-scripts/index.js';
export * from './yaar-uri.js';
export * from './design/index.js';
