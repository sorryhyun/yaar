/**
 * Structured logging — one line per event, with the ids already attached.
 *
 * The server used to say everything through `console.log('[Component] …')`. That is
 * readable one line at a time and useless in aggregate: a message crosses eight seams
 * and three agent tiers before pixels change, and reconstructing *which* session,
 * monitor, or agent a line belonged to meant reading the whole file by eye and
 * guessing from interleaving. The ids exist at every one of those sites — they were
 * simply never written down.
 *
 * So a log call names an event and its fields, and the ambient identity is filled in
 * for it:
 *
 *   const log = createLogger('AgentSession');
 *   log.warn('turn overlapped', { role, waitedFor: previousRole });
 *
 * ## Two output modes, because there are two readers
 *
 * `pretty` (default) is for the developer watching a terminal, and deliberately looks
 * like what it replaced: `[AgentSession] turn overlapped  role=main`. `json`
 * (`YAAR_LOG_FORMAT=json`) is one object per line for a collector, carrying every
 * context id and an ISO timestamp. Pretty mode shows only the two ids that help a
 * human skim — printing a full session id on every line is how a log becomes
 * unreadable — while JSON mode carries all of them.
 *
 * ## What this is not
 *
 * Not the session log. `logging/session-logger.ts` records *content* — prompts,
 * responses, tool arguments — under a session directory with its own retention. This
 * records operational events, and the two must not be confused: a field here is read
 * by whoever runs the process, so it takes ids and counts, not transcripts.
 *
 * Not the CLI's stdout. The boot banner, the remote-mode box, and the QR code in
 * `lifecycle.ts` are the program talking to its user; they stay `console.log` and are
 * exempted in eslint.config.js by path.
 *
 * ## Context is injected, not imported
 *
 * This module imports nothing. The ambient ids come from a resolver wired at boot
 * (`setLogContextResolver` in `lifecycle.ts`), the same shape as
 * `setAccessPrincipalResolver` and `setWindowGrantResolver` — and for the same reason:
 * the identity lives in `agents/agent-context.ts`, which is a long way up the import
 * graph from something every module needs to call.
 */

/** Severity. `debug` is off unless asked for; everything else prints by default. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The ambient identity of whoever is logging, as far as anyone can tell.
 *
 * Every field is optional: plenty of logging happens at boot, in HTTP routes, and in
 * background timers, where there is no agent turn to ask.
 */
export interface LogContext {
  sessionId?: string;
  monitorId?: string;
  agentId?: string;
  windowId?: string;
  appId?: string;
}

/** Structured fields for one event. Values are stringified; keep them small. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger with `fields` merged into every call — for a loop or a long-lived object. */
  child(fields: LogFields): Logger;
}

type ContextResolver = () => LogContext | undefined;

let resolveContext: ContextResolver = () => undefined;

/**
 * Teach the logger how to find the current agent context.
 *
 * Wired once, in `lifecycle.ts`. Until it is, logs simply carry no ids rather than
 * failing — boot logging happens before any session exists, and a logger that throws
 * during startup is worse than one that is briefly less specific.
 */
export function setLogContextResolver(fn: ContextResolver): void {
  resolveContext = fn;
}

/** Test seam: drop the resolver again so a suite cannot leak context into the next one. */
export function resetLogContextResolver(): void {
  resolveContext = () => undefined;
}

function parseLevel(raw: string | undefined): LogLevel {
  switch (raw) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return raw;
    default:
      return 'info';
  }
}

let minLevel: LogLevel = parseLevel(process.env.YAAR_LOG_LEVEL);
let format: 'pretty' | 'json' = process.env.YAAR_LOG_FORMAT === 'json' ? 'json' : 'pretty';

/** Test seam: pin level and format regardless of the developer's environment. */
export function configureLogging(opts: { level?: LogLevel; format?: 'pretty' | 'json' }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.format) format = opts.format;
}

/** The active minimum level — for a caller that wants to skip building an expensive field. */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

/**
 * Render one field value.
 *
 * Errors are the common case — most converted call sites used to pass `err` as a
 * second console argument — so they get their message rather than `{}`, which is what
 * `JSON.stringify(new Error('x'))` produces and what a naive conversion would have
 * silently started logging instead of the failure.
 */
function renderValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/** JSON mode keeps structure where it can; only Errors are flattened, for the same reason. */
function jsonValue(value: unknown): unknown {
  if (value instanceof Error) {
    return value.stack
      ? { message: value.message, stack: value.stack }
      : { message: value.message };
  }
  return value;
}

function emit(
  level: LogLevel,
  component: string,
  message: string,
  bound: LogFields | undefined,
  fields: LogFields | undefined,
): void {
  if (!isLevelEnabled(level)) return;

  const ctx = resolveContext() ?? {};
  const merged: LogFields = { ...bound, ...fields };

  // One console method per level, rather than folding warn into `console.error`.
  //
  // The routing is the same either way — `console.warn` and `console.error` both write to
  // stderr — but the *method* is what callers can intercept, and plenty do: the test
  // helpers spy on `console.warn` specifically to assert that a warning was issued. Routing
  // warn through `console.error` keeps the bytes on the right stream and still makes every
  // one of those spies silently observe nothing.
  //
  // These are the sanctioned console calls in the server: `no-console` is an error
  // everywhere else (see eslint.config.js), and this is the sink it points every caller at.
  /* eslint-disable no-console */
  const sink =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.log;
  /* eslint-enable no-console */

  if (format === 'json') {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component,
      message,
    };
    if (ctx.sessionId) line.sessionId = ctx.sessionId;
    if (ctx.monitorId) line.monitorId = ctx.monitorId;
    if (ctx.agentId) line.agentId = ctx.agentId;
    if (ctx.windowId) line.windowId = ctx.windowId;
    if (ctx.appId) line.appId = ctx.appId;
    for (const [key, value] of Object.entries(merged)) line[key] = jsonValue(value);
    sink(JSON.stringify(line));
    return;
  }

  // Pretty mode carries only the two ids a human skimming a terminal actually uses to
  // tell one stream of work from another. The rest are in JSON mode.
  const idParts: string[] = [];
  if (ctx.monitorId) idParts.push(`m=${ctx.monitorId}`);
  if (ctx.agentId) idParts.push(`a=${ctx.agentId}`);

  const fieldParts = Object.entries(merged).map(([key, value]) => `${key}=${renderValue(value)}`);
  const suffix = [...idParts, ...fieldParts];

  sink(`[${component}] ${message}${suffix.length ? `  ${suffix.join(' ')}` : ''}`);
}

/**
 * A logger for one component. The name replaces the `[Bracket]` prefix that used to be
 * hand-written into every string, so it cannot drift from the module it names.
 */
export function createLogger(component: string, bound?: LogFields): Logger {
  return {
    debug: (message, fields) => emit('debug', component, message, bound, fields),
    info: (message, fields) => emit('info', component, message, bound, fields),
    warn: (message, fields) => emit('warn', component, message, bound, fields),
    error: (message, fields) => emit('error', component, message, bound, fields),
    child: (fields) => createLogger(component, { ...bound, ...fields }),
  };
}
