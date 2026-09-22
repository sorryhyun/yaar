/**
 * Termux:API — the Android side of a phone that is running the server itself.
 *
 * Under Termux the "server" and the "user's device" are the same phone, so a few things a
 * desktop server can only ask the browser for are available natively: a system
 * notification, the real clipboard, the share sheet. Termux exposes them as `termux-*`
 * commands, each a thin client of a separate app (Termux:API) that holds the Android side.
 *
 * ## Why every call is timed and the probe is not `which`
 *
 * The commands come from the `termux-api` *package*; the thing that answers them is the
 * Termux:API *app*. The two are installed separately, and with the package present and the
 * app missing a command does not fail — it waits forever for a reply nobody will send. So
 * `Bun.which('termux-toast')` says nothing about whether a call will return, and every
 * call here carries a deadline and kills the process at it. {@link TermuxApi.available}
 * answers the real question by making one harmless call (`termux-battery-status`, which
 * needs no Android permission and has no visible effect) and seeing whether it comes back.
 *
 * ## Arguments never reach a shell
 *
 * Every value is its own argv element, and free text (clipboard, toast) goes over stdin so
 * a value starting with `-` cannot be read as a flag. The one exception is a notification's
 * tap action, which Termux itself runs as a shell command — {@link shellQuote} exists for
 * that and nothing else.
 */

export interface TermuxCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The deadline passed and the process was killed — the missing-app signature. */
  timedOut: boolean;
}

/** Runs one command. Injectable so tests never spawn anything. */
export type TermuxRunner = (
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number },
) => Promise<TermuxCommandResult>;

const defaultRunner: TermuxRunner = async (bin, args, { stdin, timeoutMs }) => {
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** Single-quote a string for `sh`. Only for notification actions, which Termux runs in a shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface TermuxNotification {
  /** Stable id: posting the same id again replaces the notification rather than adding one. */
  id: string;
  title: string;
  content: string;
  /** Notifications sharing a group are bundled by Android. */
  group?: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'max';
  /** Shell command Termux runs when the notification is tapped. */
  action?: string;
}

/**
 * How long one call may take. The first call into Termux:API cold-starts its app, which
 * is the slow case and still well under this; a call that is still waiting at the
 * deadline is waiting on an app that is not installed.
 */
const CALL_TIMEOUT_MS = 8_000;

export class TermuxApi {
  private probe: Promise<boolean> | null = null;

  constructor(private readonly run: TermuxRunner = defaultRunner) {}

  /**
   * Whether Termux:API answers at all. Cached for the process: the app is installed or it
   * is not, and asking again on every call would put a cold start in front of each one.
   */
  available(): Promise<boolean> {
    this.probe ??= this.call('termux-battery-status', [])
      .then((r) => {
        if (!r) return false;
        try {
          JSON.parse(r);
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    return this.probe;
  }

  /** Post (or replace, by id) a system notification. */
  async notify(n: TermuxNotification): Promise<boolean> {
    const args = ['--id', n.id, '--title', n.title, '--content', n.content];
    if (n.group) args.push('--group', n.group);
    if (n.priority) args.push('--priority', n.priority);
    if (n.action) args.push('--action', n.action);
    return (await this.call('termux-notification', args)) !== null;
  }

  async removeNotification(id: string): Promise<void> {
    await this.call('termux-notification-remove', [id]);
  }

  /** The clipboard's text, or null when the call failed. An empty clipboard is `''`. */
  getClipboard(): Promise<string | null> {
    return this.call('termux-clipboard-get', []);
  }

  async setClipboard(text: string): Promise<boolean> {
    return (await this.call('termux-clipboard-set', [], text)) !== null;
  }

  /** Open Android's share sheet for a file. Returns once the sheet is up, not once shared. */
  async shareFile(absolutePath: string, opts: { title?: string } = {}): Promise<boolean> {
    const args = ['-a', 'send'];
    if (opts.title) args.push('-t', opts.title);
    args.push(absolutePath);
    return (await this.call('termux-share', args)) !== null;
  }

  async toast(text: string, opts: { short?: boolean } = {}): Promise<boolean> {
    return (await this.call('termux-toast', opts.short ? ['-s'] : [], text)) !== null;
  }

  /** stdout on a clean exit, null on anything else (non-zero, timeout, spawn failure). */
  private async call(bin: string, args: string[], stdin?: string): Promise<string | null> {
    try {
      const r = await this.run(bin, args, { stdin, timeoutMs: CALL_TIMEOUT_MS });
      return r.code === 0 && !r.timedOut ? r.stdout : null;
    } catch {
      return null;
    }
  }
}
