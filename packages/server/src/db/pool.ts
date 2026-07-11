/**
 * Database pool — one open AppDatabase per app, with LRU eviction and idle
 * cleanup so file handles don't accumulate across many apps.
 *
 * Databases live at storage/apps/{appId}/data.db (resolved through the
 * storage manager, so path traversal is rejected the same way appStorage is).
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppDatabase } from './app-db.js';
import { resolvePath } from '../storage/storage-manager.js';

const MAX_OPEN = 20;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface PoolEntry {
  db: AppDatabase;
  lastAccess: number;
}

const pool = new Map<string, PoolEntry>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [appId, entry] of pool) {
      if (now - entry.lastAccess > IDLE_TIMEOUT_MS) {
        entry.db.close();
        pool.delete(appId);
      }
    }
    if (pool.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function evictLru(): void {
  let oldest: string | null = null;
  let oldestAccess = Infinity;
  for (const [appId, entry] of pool) {
    if (entry.lastAccess < oldestAccess) {
      oldestAccess = entry.lastAccess;
      oldest = appId;
    }
  }
  if (oldest) closeAppDatabase(oldest);
}

/** Get (or open) the SQLite database for an app. */
export function getAppDatabase(appId: string): AppDatabase {
  if (!APP_ID_RE.test(appId)) {
    throw new Error(`Invalid app id "${appId}".`);
  }

  const existing = pool.get(appId);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing.db;
  }

  if (pool.size >= MAX_OPEN) evictLru();

  const resolved = resolvePath(`apps/${appId}/data.db`);
  if (!resolved) {
    throw new Error(`Cannot resolve database path for app "${appId}".`);
  }
  mkdirSync(dirname(resolved.absolutePath), { recursive: true });

  const db = new AppDatabase(resolved.absolutePath);
  pool.set(appId, { db, lastAccess: Date.now() });
  ensureSweeper();
  return db;
}

/** Close an app's pooled database if open (e.g. on uninstall). */
export function closeAppDatabase(appId: string): void {
  const entry = pool.get(appId);
  if (!entry) return;
  entry.db.close();
  pool.delete(appId);
}

/** Close every pooled database (server shutdown). */
export function closeAllAppDatabases(): void {
  for (const entry of pool.values()) {
    entry.db.close();
  }
  pool.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
