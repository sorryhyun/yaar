/**
 * yt-dlp wrapper — media resolution and audio-only download via the yt-dlp CLI.
 *
 * yt-dlp is an OPTIONAL dependency, discovered rather than bundled (same stance as
 * Chrome in lib/browser): when the binary is absent every entry point reports
 * unavailability and nothing else in the server changes. Do not add it to the
 * release executables — its value is that its maintainers ship extractor fixes
 * within days of YouTube breakage, which a pinned bundled copy would forfeit.
 *
 * The URL is always passed as its own argv element after `--` so a hostile value
 * can neither inject options nor reach a shell.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class YtDlpError extends Error {
  constructor(
    message: string,
    /** Last stderr lines from the yt-dlp process, for diagnostics. */
    public readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'YtDlpError';
  }
}

let resolvedPath: string | null | undefined;

/**
 * Locate the yt-dlp binary. Resolution order mirrors resolveClaudeBinPath():
 * YTDLP_PATH override → alongside a bundled exe → PATH → ~/.local/bin.
 * Result is cached for the process lifetime (pass `refresh` to re-probe).
 */
export function resolveYtDlpPath(refresh = false): string | null {
  if (resolvedPath !== undefined && !refresh) return resolvedPath;
  const ext = process.platform === 'win32' ? '.exe' : '';

  const candidates: (string | null)[] = [
    process.env.YTDLP_PATH ?? null,
    // Alongside the executable (a bundled exe's user may drop yt-dlp there; inert in dev)
    join(dirname(process.execPath), `yt-dlp${ext}`),
    Bun.which('yt-dlp'),
    (() => {
      const home = process.env.USERPROFILE || process.env.HOME;
      return home ? join(home, '.local', 'bin', `yt-dlp${ext}`) : null;
    })(),
  ];

  resolvedPath = candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
  return resolvedPath;
}

export function isYtDlpAvailable(): boolean {
  return resolveYtDlpPath() !== null;
}

/** yt-dlp version string (e.g. "2026.08.19"), or null when unavailable. */
export async function ytDlpVersion(): Promise<string | null> {
  const bin = resolveYtDlpPath();
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, ['--version'], 30_000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface YtDlpAudioFormat {
  formatId: string;
  ext: string;
  acodec: string;
  /** Average audio bitrate in kbps, when yt-dlp reports one. */
  abrKbps: number | null;
  filesizeBytes: number | null;
}

export interface YtDlpMediaInfo {
  id: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  webpageUrl: string;
  /** Which yt-dlp extractor handled the URL (e.g. "youtube"). */
  extractor: string;
  audioFormats: YtDlpAudioFormat[];
}

/**
 * Resolve a media URL to its metadata and audio-only format list (`yt-dlp -J`).
 * No media bytes are transferred. Playlists are refused via --no-playlist:
 * a playlist URL resolves to its first entry, never to a fan-out.
 */
export async function resolveMediaInfo(url: string, timeoutMs = 60_000): Promise<YtDlpMediaInfo> {
  const bin = requireBin();
  const { stdout } = await run(bin, ['-J', '--no-playlist', '--no-warnings', '--', url], timeoutMs);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new YtDlpError('yt-dlp returned unparseable metadata JSON', stdout.slice(-500));
  }

  const formats = Array.isArray(raw.formats) ? (raw.formats as Record<string, unknown>[]) : [];
  const audioFormats: YtDlpAudioFormat[] = formats
    .filter((f) => f.vcodec === 'none' && typeof f.acodec === 'string' && f.acodec !== 'none')
    .map((f) => ({
      formatId: String(f.format_id ?? ''),
      ext: String(f.ext ?? ''),
      acodec: String(f.acodec),
      abrKbps: typeof f.abr === 'number' ? f.abr : null,
      filesizeBytes: typeof f.filesize === 'number' ? f.filesize : null,
    }));

  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    channel: typeof raw.channel === 'string' ? raw.channel : null,
    durationSec: typeof raw.duration === 'number' ? raw.duration : null,
    webpageUrl: typeof raw.webpage_url === 'string' ? raw.webpage_url : url,
    extractor: String(raw.extractor ?? ''),
    audioFormats,
  };
}

export interface DownloadAudioOptions {
  /** Abort the process after this long (default 15 minutes). */
  timeoutMs?: number;
  /** Refuse formats larger than this many bytes (default 512 MB). */
  maxBytes?: number;
  /** Cancels the download by killing the yt-dlp process. */
  signal?: AbortSignal;
}

export interface DownloadAudioResult {
  filePath: string;
  bytes: number;
  /** Video id / title / duration as the same yt-dlp process reported them pre-download. */
  id: string;
  title: string;
  durationSec: number | null;
}

/**
 * Download the best audio-only track of `url` into `destDir` (m4a preferred,
 * otherwise whatever bestaudio is — no ffmpeg re-encode, native container only).
 * Resolves to the final file path as yt-dlp reports it (`--print after_move:filepath`),
 * so the path is the moved, completed file — never a .part artifact. Metadata comes
 * from the same process (a pre-download `--print` line), not a second resolve.
 */
export async function downloadAudio(
  url: string,
  destDir: string,
  opts: DownloadAudioOptions = {},
): Promise<DownloadAudioResult> {
  const bin = requireBin();
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;

  const args = [
    '-f',
    'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--max-filesize',
    String(maxBytes),
    '-o',
    join(destDir, '%(id)s.%(ext)s'),
    '--no-simulate',
    // Printed before the download; title goes last because it may itself contain '|'.
    '--print',
    '%(id)s|%(duration)s|%(title)s',
    '--print',
    'after_move:filepath',
    '--',
    url,
  ];

  const { stdout } = await run(bin, args, timeoutMs, opts.signal);
  const lines = stdout.trim().split('\n');
  const filePath = lines.at(-1) ?? '';
  // --max-filesize refusal exits 0 but downloads (and prints) nothing after the meta line.
  if (lines.length < 2 || !filePath || !existsSync(filePath)) {
    throw new YtDlpError(
      `yt-dlp completed without producing a file (over the ${Math.round(maxBytes / 1024 / 1024)}MB limit, or nothing to download)`,
      '',
    );
  }
  const [id = '', duration = '', ...titleParts] = (lines[0] ?? '').split('|');
  const bytes = (await Bun.file(filePath).stat()).size;
  return {
    filePath,
    bytes,
    id,
    title: titleParts.join('|'),
    durationSec: /^\d+(\.\d+)?$/.test(duration) ? Number(duration) : null,
  };
}

function requireBin(): string {
  const bin = resolveYtDlpPath();
  if (!bin) {
    throw new YtDlpError(
      'yt-dlp is not installed. Install it (e.g. `brew install yt-dlp`, or the standalone ' +
        'binary into ~/.local/bin) or set YTDLP_PATH, then retry.',
      '',
    );
  }
  return bin;
}

async function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (signal?.aborted) throw new YtDlpError('Cancelled before yt-dlp started', '');
  const proc = Bun.spawn([bin, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    proc.kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      if (cancelled) throw new YtDlpError('Cancelled', '');
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      // yt-dlp's last ERROR: line is the human-readable cause — surface it directly.
      const errLine = tail
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('ERROR:'));
      throw new YtDlpError(errLine ?? `yt-dlp exited with code ${exitCode}`, tail);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
