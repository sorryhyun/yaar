// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * App-scoped database (SQLite-backed collections) — wraps the
 * `yaar://apps/self/db/` verbs.
 */

// Solid.js primitives — imported from solid-js directly (the Bun plugin resolves to the browser build)
import { createSignal, getOwner, onCleanup } from 'solid-js';

import { y } from './verbs.js';

function appDbUri(path: string): string {
  const clean = path.replace(/^\//, '');
  return clean ? `yaar://apps/self/db/${clean}` : 'yaar://apps/self/db';
}

/**
 * Handle for one collection in the app's SQLite database.
 *
 * Filters are Mongo-style: exact match `{ status: 'active' }`, operators
 * `{ age: { $gt: 18 } }` ($gt/$gte/$lt/$lte/$ne/$in/$exists), array contains
 * `{ tags: 'intro' }`. Requires `yaar://apps/self/db/` in app.json permissions.
 */
class CollectionHandle {
  constructor(name) {
    this.name = name;
  }

  /** Insert a document. Returns the generated _id. */
  async insert(doc) {
    const result = await y.invoke(appDbUri(this.name), { action: 'insert', doc });
    return result._id;
  }

  /** Insert many documents in one transaction. Returns generated ids. */
  async insertMany(docs) {
    const result = await y.invoke(appDbUri(this.name), { action: 'insertMany', docs });
    return result.ids;
  }

  /** Fetch one document by _id, or null if it doesn't exist. */
  async get(id) {
    try {
      return await y.read(appDbUri(`${this.name}/${id}`));
    } catch {
      return null;
    }
  }

  /** Query documents. Options: { sort: { field: 1 | -1 }, limit, offset }. */
  async find(filter, options) {
    return y.invoke(appDbUri(this.name), { action: 'find', filter, ...(options ?? {}) });
  }

  /** Full-text search across all document fields, best matches first. */
  async search(query, limit) {
    return y.invoke(appDbUri(this.name), {
      action: 'search',
      query,
      ...(limit != null ? { limit } : {}),
    });
  }

  /** Shallow-merge patch into the stored document. */
  async update(id, patch) {
    await y.invoke(appDbUri(`${this.name}/${id}`), { action: 'update', patch });
  }

  /** Delete one document by _id. */
  async remove(id) {
    await y.delete(appDbUri(`${this.name}/${id}`));
  }

  /** Delete all documents matching a (non-empty) filter. Returns deleted count. */
  async removeWhere(filter) {
    const result = await y.invoke(appDbUri(this.name), { action: 'removeWhere', filter });
    return result.deleted;
  }

  /** Count documents matching the filter (all documents when omitted). */
  async count(filter) {
    const result = await y.invoke(appDbUri(this.name), { action: 'count', filter });
    return result.count;
  }
}

export const appDb = {
  /** Get a collection handle (lazy — no network call until used). */
  collection(name) {
    return new CollectionHandle(name);
  },

  /** List collection names in this app's database. */
  async collections() {
    const result = await y.list(appDbUri(''));
    if (!Array.isArray(result)) return [];
    return result.map((entry) => (typeof entry === 'string' ? entry : entry.name));
  },

  /** Drop a collection and all its documents. */
  async drop(name) {
    await y.delete(appDbUri(name));
  },

  /**
   * Reactive Solid.js binding for a collection query.
   *
   * Returns `[docs, { insert, update, remove, refresh, dispose }]` where
   * `docs()` is a signal holding the current query results. Mutations made
   * through the returned helpers refresh the signal; changes made elsewhere
   * (another window, the agent) arrive via a verb subscription when the app
   * has read permission on `yaar://apps/self/db/`.
   */
  createReactiveCollection(name, options) {
    const handle = new CollectionHandle(name);
    const [docs, setDocs] = createSignal([]);
    let disposed = false;

    const refresh = async () => {
      try {
        const results = await handle.find(options?.filter, options);
        if (!disposed) setDocs(() => results);
      } catch (e) {
        console.error(`[yaar] appDb.createReactiveCollection("${name}"): refresh failed`, e);
      }
    };
    void refresh();

    // Best-effort external-change subscription — mutations from other windows
    // or the agent trigger a refetch. Failures are fine; local mutations
    // still refresh explicitly.
    let unsubscribe = null;
    try {
      Promise.resolve(y.subscribe(appDbUri(name), () => void refresh()))
        .then((unsub) => {
          if (disposed) unsub?.();
          else unsubscribe = unsub;
        })
        .catch(() => {});
    } catch {
      // subscribe unavailable — polling-free local mode
    }

    const dispose = () => {
      disposed = true;
      unsubscribe?.();
    };
    if (getOwner()) onCleanup(dispose);

    const after = async (promise) => {
      const result = await promise;
      await refresh();
      return result;
    };

    return [
      docs,
      {
        insert: (doc) => after(handle.insert(doc)),
        update: (id, patch) => after(handle.update(id, patch)),
        remove: (id) => after(handle.remove(id)),
        refresh,
        dispose,
      },
    ];
  },
};
