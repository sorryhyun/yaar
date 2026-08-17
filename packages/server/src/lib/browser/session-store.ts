/**
 * BrowserSessionStore — what a named browser session was, written down.
 *
 * A `BrowserSession` is a live CDP socket, and a CDP socket is the most fragile
 * thing in this subsystem: Chrome crashes a renderer, the server restarts under
 * `--watch`, the desktop reloads. Work item 4 of the Interactive Browser proposal
 * asks for sessions that behave like processes rather than request handlers, and
 * the first thing a process has that a socket does not is a name and a last known
 * state that outlive the connection.
 *
 * So each session's *identity* — its id, the page it was on, the window it was
 * bound to — is kept here, on disk, separately from the socket that happens to be
 * serving it right now. Reviving is then a matter of opening a fresh tab and
 * replaying the record; with the profile persisted alongside it (see
 * `config/browser.ts`), the replayed page is still logged in.
 *
 * Deliberately not a database. It is a handful of rows, read once at boot and
 * written on change, and a corrupt or missing file must cost nothing more than the
 * revive — so every failure here is swallowed and the caller carries on with an
 * empty store.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getBrowserStateDir } from '../../config.js';

/** One named session, as it looked the last time anything changed. */
export interface BrowserSessionRecord {
  id: string;
  url: string;
  title: string;
  mobile: boolean;
  /** The YAAR window this session was bound to, if any. */
  windowId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * How long a record survives with nothing reviving it.
 *
 * Without a ceiling the file is an ever-growing list of tabs the user closed
 * months ago, each one a name that `createSession` would refuse as taken. Two
 * weeks is comfortably longer than "I'll get back to this tomorrow" and shorter
 * than "I have no idea what that is".
 */
const RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Debounce window for the write-behind. Bursts of navigation are one write. */
const FLUSH_DELAY_MS = 500;

function storePath(): string {
  return join(getBrowserStateDir(), 'sessions.json');
}

export class BrowserSessionStore {
  private records = new Map<string, BrowserSessionRecord>();
  private loaded = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Read the file once. Safe to call on every access — the second call is free,
   * and a failed load still marks the store loaded so a broken file is not
   * re-read on every navigation.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(storePath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const entry of parsed) {
        const rec = asRecord(entry);
        if (!rec) continue;
        if (now - rec.updatedAt > RECORD_TTL_MS) continue;
        this.records.set(rec.id, rec);
      }
    } catch {
      // No file yet, or an unreadable one. Either way there is nothing to revive.
    }
  }

  get(id: string): BrowserSessionRecord | undefined {
    return this.records.get(id);
  }

  list(): BrowserSessionRecord[] {
    return [...this.records.values()];
  }

  /** Record (or update) a session. Fields left out keep their previous value. */
  remember(id: string, patch: Partial<Omit<BrowserSessionRecord, 'id'>>): void {
    const now = Date.now();
    const prev = this.records.get(id);
    this.records.set(id, {
      id,
      url: patch.url ?? prev?.url ?? 'about:blank',
      title: patch.title ?? prev?.title ?? '',
      mobile: patch.mobile ?? prev?.mobile ?? false,
      // An explicit `undefined` means "no longer bound to a window", which is
      // different from "not mentioned" — so read the key, not the value.
      windowId: 'windowId' in patch ? patch.windowId : prev?.windowId,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    this.scheduleFlush();
  }

  forget(id: string): void {
    if (!this.records.delete(id)) return;
    this.scheduleFlush();
  }

  /** Write now and wait for it — for shutdown, where the debounce would be lost. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.write();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.write();
    }, FLUSH_DELAY_MS);
    // A pending write must never be the reason a test run or a shutdown hangs.
    this.flushTimer.unref?.();
  }

  /**
   * Serialize writes through one chain: `remember` can fire faster than the disk,
   * and two overlapping rename-into-place calls are how the file ends up empty.
   */
  private write(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const path = storePath();
      const tmp = `${path}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify(this.list(), null, 2), 'utf-8');
        await rename(tmp, path);
      } catch {
        // Losing the record costs a revive, never a running session.
      }
    });
    return this.writing;
  }
}

function asRecord(entry: unknown): BrowserSessionRecord | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Date.now());
  return {
    id: e.id,
    url: typeof e.url === 'string' ? e.url : 'about:blank',
    title: typeof e.title === 'string' ? e.title : '',
    mobile: e.mobile === true,
    ...(typeof e.windowId === 'string' ? { windowId: e.windowId } : {}),
    createdAt: num(e.createdAt),
    updatedAt: num(e.updatedAt),
  };
}
