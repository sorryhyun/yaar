/**
 * Hosting `claude remote-control` — this machine, driven from claude.ai/code or the
 * Claude mobile app.
 *
 * Why a PTY and not a pipe: `remote-control` is a TTY program, and under plain stdio it
 * does not behave like the one a user runs in a terminal. Bun's built-in `terminal`
 * spawn option gives it a real pseudo-terminal (no node-pty), so everything the CLI
 * prints — including the session URL and any interactive prompt — arrives here as
 * terminal bytes.
 *
 * One host at a time. The process is a YAAR-owned child: `stopRemoteControl()` is
 * called from `lifecycle.ts`'s shutdown so it never outlives the server. A restarted
 * YAAR reattaches with `continue: true` (the CLI's `--continue`).
 *
 * The remote session is a YAAR monitor agent, not a stock Claude Code: its cwd and env
 * are generated from the monitor agent's SDK options (`agent-config.ts`), and its MCP
 * calls carry a token registered as a `monitor` principal on the monitor that started
 * it (`mcp/external-principals.ts`). Both are torn down when the process exits.
 *
 * Every state change pings subscribers of `REMOTE_CONTROL_URI` — the Remote Control app
 * follows the host that way instead of polling, terminal tail included.
 */

import type { Subprocess } from 'bun';
import { getClaudeSpawnArgs } from '../../config.js';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { createLogger } from '../../observability/log.js';
import { revokeAgentToken } from '../../mcp/agent-tokens.js';
import {
  registerExternalPrincipal,
  unregisterExternalPrincipal,
} from '../../mcp/external-principals.js';
import type { SessionId } from '../../session/types.js';
import { REMOTE_AGENT_ID, writeRemoteAgentConfig } from './agent-config.js';

const log = createLogger('RemoteControl');

export const REMOTE_CONTROL_URI = 'yaar://system/remote-control';

/** Raw terminal bytes kept for `read`. Enough for the banner, the URL and a prompt. */
const OUTPUT_LIMIT = 64 * 1024;
/** How much ANSI-stripped tail `read` returns. */
const TAIL_CHARS = 4000;
const COLS = 120;
const ROWS = 40;
/** Terminal output arrives in bursts; subscribers hear about a burst once. */
const OUTPUT_NOTIFY_MS = 250;

export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;
/**
 * No `worktree`: the generated cwd is git-ignored inside the YAAR checkout, so a worktree
 * session would start in a fresh checkout with none of `agent-config.ts`'s files and run
 * as a stock Claude Code with the repo's own project settings.
 */
export const SPAWN_MODES = ['same-dir', 'session'] as const;

export type RemoteControlState = 'starting' | 'ready' | 'exited';

export interface StartOptions {
  name?: string;
  permissionMode?: (typeof PERMISSION_MODES)[number];
  spawn?: (typeof SPAWN_MODES)[number];
  /** Reattach to the session last recorded for the generated cwd (`--continue`). */
  continue?: boolean;
}

export interface RemoteControlStatus {
  running: boolean;
  state: RemoteControlState | null;
  pid: number | null;
  cwd: string | null;
  /** The monitor the remote agent acts on. */
  monitorId: string | null;
  args: string[];
  startedAt: string | null;
  /** The claude.ai/code URL the CLI printed (environment or session link), once it has. */
  sessionUrl: string | null;
  exitCode: number | null;
  /** ANSI-stripped end of the terminal output. */
  tail: string;
}

/** A refused request — the caller's mistake, reported as a verb error. */
export class RemoteControlRequestError extends Error {}

interface Host {
  proc: Subprocess;
  state: RemoteControlState;
  cwd: string;
  monitorId: string;
  args: string[];
  startedAt: Date;
  output: string;
  sessionUrl: string | null;
  exitCode: number | null;
}

let host: Host | null = null;
let outputNotify: ReturnType<typeof setTimeout> | null = null;

function notifyChanged(): void {
  if (outputNotify) {
    clearTimeout(outputNotify);
    outputNotify = null;
  }
  subscriptionRegistry.notifyChange(REMOTE_CONTROL_URI);
}

function notifyOutput(): void {
  outputNotify ??= setTimeout(notifyChanged, OUTPUT_NOTIFY_MS);
}

// OSC 8 hyperlinks carry the URL inside the escape, which stripANSI removes — so the
// URL is matched against the raw bytes, where the character class stops at ESC/BEL.
// The environment form is what `remote-control` prints for its host; the session form is
// kept for a CLI that links one session.
const SESSION_URL =
  /https:\/\/claude\.ai\/code(?:\/session_[A-Za-z0-9_]+|\?environment=env_[A-Za-z0-9_]+)/g;

function lastMatch(text: string, re: RegExp): string | null {
  const all = text.match(re);
  return all ? all[all.length - 1] : null;
}

function buildArgs(opts: StartOptions): string[] {
  const args = ['remote-control'];
  if (opts.continue) {
    args.push('--continue');
  }
  if (opts.name) args.push('--name', opts.name);
  if (opts.permissionMode) {
    if (!PERMISSION_MODES.includes(opts.permissionMode)) {
      throw new RemoteControlRequestError(`Unknown permissionMode: ${opts.permissionMode}`);
    }
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.continue) {
    // The CLI refuses `--spawn` beside `--continue`: a reattach keeps the recorded mode.
    if (opts.spawn) {
      throw new RemoteControlRequestError('`spawn` cannot be combined with `continue`.');
    }
  } else {
    const spawn = opts.spawn ?? 'same-dir';
    if (!SPAWN_MODES.includes(spawn)) {
      throw new RemoteControlRequestError(`Unknown spawn mode: ${spawn}`);
    }
    // Always explicit: without it a first run stops on an interactive spawn-mode prompt
    // that also offers `worktree`.
    args.push('--spawn', spawn);
  }
  // Claude in Chrome is not a monitor-agent tool; the machine's /chrome setting would
  // otherwise hand it to every spawned session.
  args.push('--no-chrome');
  return args;
}

/** Validate a start request without spawning — so the dialog is never shown for a bad one. */
export function prepareStart(opts: StartOptions): { args: string[] } {
  if (process.platform === 'win32') {
    throw new RemoteControlRequestError('Remote Control hosting needs a POSIX PTY (not Windows).');
  }
  if (host && host.state !== 'exited') {
    throw new RemoteControlRequestError(
      `Remote Control is already running (pid ${host.proc.pid}). Stop it first.`,
    );
  }
  return { args: buildArgs(opts) };
}

export async function startRemoteControl(
  prepared: { args: string[] },
  target: { sessionId: SessionId | undefined; monitorId: string },
): Promise<RemoteControlStatus> {
  if (host && host.state !== 'exited') {
    throw new RemoteControlRequestError('Remote Control is already running.');
  }
  const decoder = new TextDecoder();
  const argv = [...getClaudeSpawnArgs(), ...prepared.args];
  const { cwd, env } = await writeRemoteAgentConfig(target.monitorId);
  // Re-checked after the await: two starts can both pass the check above.
  if (host && host.state !== 'exited') {
    throw new RemoteControlRequestError('Remote Control is already running.');
  }
  registerExternalPrincipal(REMOTE_AGENT_ID, { ...target, role: 'monitor' });

  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...env, TERM: 'xterm-256color' },
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_terminal, chunk) {
        if (!current || current.proc !== proc) return;
        current.output = (current.output + decoder.decode(chunk, { stream: true })).slice(
          -OUTPUT_LIMIT,
        );
        const url = lastMatch(current.output, SESSION_URL);
        if (url && url !== current.sessionUrl) {
          current.sessionUrl = url;
          current.state = 'ready';
          log.info('remote control session ready', { pid: proc.pid });
          notifyChanged();
        } else {
          notifyOutput();
        }
      },
    },
  });

  const current: Host = {
    proc,
    state: 'starting',
    cwd,
    monitorId: target.monitorId,
    args: prepared.args,
    startedAt: new Date(),
    output: '',
    sessionUrl: null,
    exitCode: null,
  };
  host = current;
  log.info('remote control started', { pid: proc.pid });

  void proc.exited.then((code) => {
    current.state = 'exited';
    current.exitCode = code;
    proc.terminal?.close();
    // Only if no newer host took the principal over in the meantime.
    if (host === current) {
      revokeAgentToken(REMOTE_AGENT_ID);
      unregisterExternalPrincipal(REMOTE_AGENT_ID);
    }
    log.info('remote control exited', { pid: proc.pid, code });
    notifyChanged();
  });

  notifyChanged();
  return getRemoteControlStatus();
}

export function getRemoteControlStatus(): RemoteControlStatus {
  if (!host) {
    return {
      running: false,
      state: null,
      pid: null,
      cwd: null,
      monitorId: null,
      args: [],
      startedAt: null,
      sessionUrl: null,
      exitCode: null,
      tail: '',
    };
  }
  return {
    running: host.state !== 'exited',
    state: host.state,
    pid: host.proc.pid,
    cwd: host.cwd,
    monitorId: host.monitorId,
    args: host.args,
    startedAt: host.startedAt.toISOString(),
    sessionUrl: host.sessionUrl,
    exitCode: host.exitCode,
    tail: Bun.stripANSI(host.output).slice(-TAIL_CHARS),
  };
}

/** Type into the host's terminal — to answer a prompt the CLI is waiting on. */
export function writeRemoteControl(data: string): void {
  if (!host || host.state === 'exited' || !host.proc.terminal) {
    throw new RemoteControlRequestError('Remote Control is not running.');
  }
  host.proc.terminal.write(data);
}

/** Stop the host. SIGINT first (the CLI's own Ctrl-C path), SIGKILL if it lingers. */
export async function stopRemoteControl(): Promise<boolean> {
  const current = host;
  if (!current || current.state === 'exited') return false;
  current.proc.kill('SIGINT');
  const exited = await Promise.race([
    current.proc.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) current.proc.kill('SIGKILL');
  return true;
}
