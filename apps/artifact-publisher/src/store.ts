// Data: installed apps, the build/publish in flight, the last failure, and the published
// history (appDb collection `published`, one row per app id).

import { createSignal } from '@bundled/solid-js';
import { appDb, createSharedSignal, list } from '@bundled/yaar';
import * as z from '@bundled/zod';

export interface AppEntry {
  id: string;
  name: string;
  description: string;
  version: string | null;
}

export interface Published {
  appId: string;
  /** Relative to this app's storage root: `projects/<appId>/dist/index.html`. */
  path: string;
  url: string;
  title: string;
  publishedAt: string;
}

export type Step = 'cloning' | 'compiling' | 'publishing';

export interface Activity {
  appId: string;
  step: Step;
  since: string;
}

export interface Failure {
  appId: string;
  stage: 'build' | 'publish';
  messages: string[];
}

export const SELF_ID = 'artifact-publisher';

export const [apps, setApps] = createSignal<AppEntry[]>([]);

// Shared, because a command (build, recordPublished, publishFailed) reaches one copy of
// the window only and every copy must show the same progress and outcome.
export const [selected, setSelected] = createSharedSignal<string | null>('selected', null);
export const [activity, setActivity] = createSharedSignal<Activity | null>('activity', null);
export const [failure, setFailure] = createSharedSignal<Failure | null>('failure', null);

export function startStep(appId: string, step: Step): void {
  setActivity({ appId, step, since: new Date().toISOString() });
}

// ── Installed apps ──────────────────────────────────────────────────────────

// `list('yaar://apps')` answers resource links; validated per row so one odd entry
// does not hide the rest.
const AppLink = z.object({
  uri: z.string(),
  name: z.optional(z.string()),
  description: z.optional(z.string()),
  version: z.optional(z.string()),
});

export async function refreshApps(): Promise<AppEntry[]> {
  const raw = await list<unknown>('yaar://apps');
  const out: AppEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const row = z.safeParse(AppLink, item);
    if (!row.success) continue;
    const id = row.data.uri.replace(/^yaar:\/\/apps\//, '').replace(/\/$/, '');
    if (!id || id === SELF_ID) continue;
    out.push({
      id,
      name: row.data.name ?? id,
      description: row.data.description ?? '',
      version: row.data.version ?? null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  setApps(out);
  return out;
}

// ── Published history ───────────────────────────────────────────────────────

const historyCollection = appDb.collection<Published>('published');
const [historyDocs, historyDb] = appDb.createReactiveCollection<Published>('published', {
  sort: { publishedAt: -1 },
  limit: 200,
});

// Rows normally come from recordPublished, but the collection is also reachable at
// yaar://apps/artifact-publisher/db/published, so each row is validated on its own.
const PublishedRow = z.object({
  appId: z.string(),
  path: z.string(),
  url: z.string(),
  title: z.optional(z.string()),
  publishedAt: z.optional(z.string()),
});
const reportedBadRows = new Set<string>();

/** SQLite datetime ("YYYY-MM-DD HH:MM:SS", UTC) → ISO string. */
function dbDateToIso(value: string): string {
  return value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
}

export function history(): Published[] {
  const out: Published[] = [];
  for (const doc of historyDocs()) {
    const row = z.safeParse(PublishedRow, doc);
    if (!row.success) {
      if (!reportedBadRows.has(doc._id)) {
        reportedBadRows.add(doc._id);
        console.warn('[artifact-publisher] skipping malformed history row', doc._id, row.error);
      }
      continue;
    }
    out.push({
      appId: row.data.appId,
      path: row.data.path,
      url: row.data.url,
      title: row.data.title ?? row.data.appId,
      publishedAt: row.data.publishedAt ?? dbDateToIso(doc._created_at),
    });
  }
  return out;
}

export function publishedFor(appId: string): Published | undefined {
  return history().find((h) => h.appId === appId);
}

/** Upsert by app id: republishing the same file keeps its URL, so it stays one row. */
export async function savePublished(entry: Published): Promise<{ updated: boolean }> {
  const [existing] = await historyCollection.find({ appId: entry.appId }, { limit: 1 });
  if (existing) await historyDb.update(existing._id, entry);
  else await historyDb.insert(entry);
  return { updated: !!existing };
}
