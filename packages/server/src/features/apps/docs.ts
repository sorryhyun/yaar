/**
 * The app docs tier — `agent/docs/*.md`, one file per topic.
 *
 * App knowledge used to come in exactly two sizes: always-loaded (`agent/prompt.md`,
 * rebuilt into every app-agent turn) and monolithic-on-demand (`agent/SKILL.md` via
 * describe). Growth therefore landed in the wrong tier — devtools' prompt carried ~17 KB
 * of reference prose on every turn because there was nowhere cheaper to put it. This
 * module is the third size: a topic is pulled when its trigger fires, and the only thing
 * the always-loaded tier carries is the *index* — one scent line per topic.
 *
 * The index is the contract. A pull-based doc is only reachable if the agent knows it
 * exists, so a topic's `description` must be written as a trigger ("read before touching
 * X"), not a summary — that line is the topic's entire static-tier footprint, and
 * `scripts/check/apps.ts` lints it.
 *
 * Four doors serve the same files:
 *  - `yaar://apps/{id}/docs[/{name}]` (`handlers/apps/docs-resource.ts`) — the verbs door.
 *  - `describe('yaar://apps/{id}')` and the app agent's `describe` tool — carry the index.
 *  - `describe({ topic })` on the app agent's tool — one topic, for the caller with no verbs.
 *  - The filesystem — clone and deploy carry `agent/docs/` like any other agent doc, so a
 *    coding agent editing a cloned app reads the same tree.
 *
 * `audience` decides which doors index a topic: `agent` topics serve the app's own
 * runtime agent, `dev` topics serve whoever edits the source (reached through the clone),
 * `both` serves both. Runtime doors index `agent|both`; a `dev` topic is still readable
 * by name — it is unindexed, not secret.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { resolveAppDir } from './roots.js';
import { createLogger } from '../../observability/log.js';
// The grammar lives in a leaf shared with `scripts/check/apps.ts`, so "valid to the
// lint" and "valid to the runtime" stay one predicate — see that file's header.
import {
  AGENT_DOCS_DIR,
  DOC_SLUG_RE,
  DOC_AUDIENCES,
  parseDocFrontmatter,
  type AppDocAudience,
} from './doc-frontmatter.js';

export { AGENT_DOCS_DIR, DOC_SLUG_RE, parseDocFrontmatter, type AppDocAudience };

const log = createLogger('apps');

export interface AppDocTopic {
  /** Kebab-case slug — the filename stem, the URI segment, and the `topic` param. */
  name: string;
  /** One line of scent: the trigger that should make an agent pull this topic. */
  description: string;
  audience: AppDocAudience;
  /** Source paths (globs allowed) this topic is authoritative for. */
  covers: string[];
  /** The markdown body, frontmatter stripped. */
  body: string;
}

/**
 * One file → one topic, or null with a warning when the file cannot be addressed.
 *
 * Tolerant where the check script is strict: a deployed user-app is not gated by repo
 * lint, so a missing description falls back to the body's first non-empty line rather
 * than making the topic invisible. Only an unaddressable name — a stem the slug rule
 * rejects — drops the file, because a URI segment is not a place for best effort.
 */
function toTopic(appId: string, filename: string, content: string): AppDocTopic | null {
  const stem = filename.replace(/\.md$/, '');
  if (!DOC_SLUG_RE.test(stem)) {
    log.warn('app doc filename is not a kebab-case slug — the topic is unreachable', {
      appId,
      filename,
    });
    return null;
  }

  const { fields, body } = parseDocFrontmatter(content);
  if (typeof fields.name === 'string' && fields.name !== stem) {
    log.warn('app doc frontmatter name disagrees with its filename — the filename wins', {
      appId,
      filename,
      declared: fields.name,
    });
  }

  const description =
    typeof fields.description === 'string' && fields.description
      ? fields.description
      : (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim();

  const audience =
    typeof fields.audience === 'string' &&
    (DOC_AUDIENCES as readonly string[]).includes(fields.audience)
      ? (fields.audience as AppDocAudience)
      : 'both';

  const covers = Array.isArray(fields.covers)
    ? fields.covers
    : typeof fields.covers === 'string' && fields.covers
      ? [fields.covers]
      : [];

  return { name: stem, description, audience, covers, body };
}

/**
 * Every topic an app ships, sorted by name. `[]` for an app with no `agent/docs/` —
 * absence is the common case, not an error, same as the single-file agent docs.
 */
export async function loadAppDocs(appId: string): Promise<AppDocTopic[]> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return [];

  let entries: string[];
  try {
    entries = await readdir(join(appDir, AGENT_DOCS_DIR));
  } catch {
    return [];
  }

  const topics: AppDocTopic[] = [];
  for (const filename of entries.filter((f) => f.endsWith('.md')).sort()) {
    try {
      const content = await Bun.file(join(appDir, AGENT_DOCS_DIR, filename)).text();
      const topic = toTopic(appId, filename, content);
      if (topic) topics.push(topic);
    } catch {
      /* unreadable file — skip it, the listing already sorted the rest */
    }
  }
  return topics;
}

/** One topic by slug, or null. The lookup is by addressable name, not filename. */
export async function loadAppDocTopic(appId: string, name: string): Promise<AppDocTopic | null> {
  const topics = await loadAppDocs(appId);
  return topics.find((t) => t.name === name) ?? null;
}

/**
 * The topics a runtime door should index: what the app's own agent (or an agent driving
 * it) can act on. `dev` topics are for whoever edits the source and reach that reader
 * through the clone; indexing them at runtime would spend scent lines on triggers that
 * cannot fire there.
 */
export function runtimeDocs(topics: AppDocTopic[]): AppDocTopic[] {
  return topics.filter((t) => t.audience !== 'dev');
}

/**
 * The topic files an app on disk keeps, as root-relative paths — what clone and deploy
 * carry. Enumerated rather than derived from `loadAppDocs` because the callers hold an
 * arbitrary directory (a sandbox, an app root), not an installed appId.
 */
export async function agentDocsFilesFor(appDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(appDir, AGENT_DOCS_DIR));
    return entries
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `${AGENT_DOCS_DIR}/${f}`);
  } catch {
    return [];
  }
}
