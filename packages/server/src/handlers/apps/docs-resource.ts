/**
 * `yaar://apps/{appId}/docs[/{name}]` — the app's topic docs, addressable one at a time.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts`, like the
 * protocol resource beside it. Each entry point returns `null` for a non-docs URI so the
 * composite can fall through.
 *
 * ## Why this resource exists
 *
 * `agent/docs/*.md` is the pull tier of app knowledge (`features/apps/docs.ts`): topics
 * too long for the always-loaded prompt and too specific for `SKILL.md`. This door is the
 * verbs spelling of that tier, with the verbs meaning what they mean everywhere else:
 *
 * | verb | on `…/docs` | answers |
 * |---|---|---|
 * | `describe` | the resource | what this tier is and how to slice it — never grows |
 * | `list` | the index | one scent line per topic |
 * | `read` | `…/docs/{name}` | one topic body, markdown |
 *
 * The index a runtime caller gets is audience-filtered (`agent`/`both`): a `dev` topic's
 * trigger is "you are editing this source file", which cannot fire for a caller holding
 * verbs instead of a clone. A dev topic is still readable *by name* — unindexed, not
 * secret — so a coding agent that learned the name from a clone's index can follow it here.
 */

import type { VerbResult } from '../uri-registry.js';
import { okJson, okLinks, okResource, error, prependNote } from '../utils.js';
import { listApps } from '../../features/apps/discovery.js';
import { loadAppDocs, runtimeDocs, type AppDocTopic } from '../../features/apps/docs.js';
import { parseAppDocsPath } from './paths.js';

/** A parsed, validated docs address, or the refusal that explains why it isn't one. */
type Target = { ok: true; appId: string; name?: string } | { ok: false; result: VerbResult };

function parseTarget(uri: string): Target | null {
  const parsed = parseAppDocsPath(uri);
  if (!parsed) return null;

  const { appId, rest } = parsed;
  if (!rest) return { ok: true, appId };
  if (rest.includes('/')) {
    return {
      ok: false,
      result: error(
        `"${uri}" is too deep. One topic per address: yaar://apps/${appId}/docs/{name}.`,
      ),
    };
  }
  return { ok: true, appId, name: rest };
}

/** Either the app's topics, or the refusal explaining why there aren't any. */
async function loadTopics(appId: string): Promise<AppDocTopic[] | ReturnType<typeof error>> {
  const apps = await listApps();
  if (!apps.some((a) => a.id === appId)) return error(`App "${appId}" not found.`);
  const topics = await loadAppDocs(appId);
  if (topics.length === 0) {
    return error(
      `App "${appId}" ships no topic docs (agent/docs/). ` +
        `describe("yaar://apps/${appId}") for what it does document.`,
    );
  }
  return topics;
}

/** The not-found answer that names what *is* addressable, so a near-miss costs one call. */
function unknownTopic(appId: string, name: string, topics: AppDocTopic[]): VerbResult {
  return error(
    `"${name}" is not a doc topic of "${appId}". ` +
      `Declared: ${topics.map((t) => t.name).join(', ')}.`,
  );
}

/** `describe` — what this tier is, not what it says. Counts and doors, never grows. */
export async function describeAppDocs(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;

  const loaded = await loadTopics(target.appId);
  if (!Array.isArray(loaded)) return loaded;
  const base = `yaar://apps/${target.appId}/docs`;

  if (target.name) {
    const topic = loaded.find((t) => t.name === target.name);
    if (!topic) return unknownTopic(target.appId, target.name, loaded);
    return okJson({
      uri,
      name: topic.name,
      description: topic.description,
      audience: topic.audience,
      ...(topic.covers.length ? { covers: topic.covers } : {}),
      read: `read("${uri}") for the topic itself.`,
    });
  }

  const indexed = runtimeDocs(loaded);
  return okJson({
    uri: base,
    appId: target.appId,
    what:
      `Topic docs of the installed app "${target.appId}" — hand-written reference the app's ` +
      'prompt and SKILL.md deliberately do not carry. Each topic names its own trigger; pull ' +
      'one when its trigger fires, not before.',
    topics: indexed.length,
    ...(loaded.length > indexed.length
      ? {
          devTopics:
            `${loaded.length - indexed.length} more serve whoever edits the app's source; ` +
            'they are indexed in the cloned tree, not here.',
        }
      : {}),
    verbs: ['describe', 'read', 'list'],
    doors: {
      index: `list("${base}") — one line per topic: its name and its trigger. Start here.`,
      one: `read("${base}/{name}") — one topic in full, markdown.`,
    },
  });
}

/** `read` — one topic body. The whole collection has no single read: pull by trigger. */
export async function readAppDocs(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;

  const loaded = await loadTopics(target.appId);
  if (!Array.isArray(loaded)) return loaded;
  const base = `yaar://apps/${target.appId}/docs`;

  if (!target.name) {
    return error(
      `"${base}" is the tier, not a document — topics are pulled one at a time, by trigger. ` +
        `list("${base}") for the index, read("${base}/{name}") for one.`,
    );
  }

  const topic = loaded.find((t) => t.name === target.name);
  if (!topic) return unknownTopic(target.appId, target.name, loaded);
  return okResource(uri, topic.body, 'text/markdown');
}

/** `list` — the index: a scent line per topic, enough to know when to pull one. */
export async function listAppDocs(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;
  if (target.name) {
    return error(
      `"${uri}" is one topic, not a collection. Use read("${uri}") for it, or ` +
        `list("yaar://apps/${target.appId}/docs") for the index.`,
    );
  }

  const loaded = await loadTopics(target.appId);
  if (!Array.isArray(loaded)) return loaded;
  const base = `yaar://apps/${target.appId}/docs`;

  return prependNote(
    okLinks(
      runtimeDocs(loaded).map((t) => ({
        uri: `${base}/${t.name}`,
        name: t.name,
        description: t.description,
      })),
    ),
    `the index — each description is the topic's trigger; read("${base}/{name}") for one in full`,
  );
}

/**
 * Docs are documentation — read, never run and never written from here. The write path
 * is the app's source tree (devtools edits `agent/docs/` like any other file), so the
 * refusal points there rather than just saying no.
 */
export function rejectDocsMutation(uri: string, verb: 'invoke' | 'delete'): VerbResult | null {
  const parsed = parseAppDocsPath(uri);
  if (!parsed) return null;
  return error(
    `Cannot ${verb === 'invoke' ? 'invoke' : 'delete'} "${uri}" — topic docs are part of the ` +
      `app's source (agent/docs/). Edit or remove the file in the app's tree and redeploy.`,
  );
}
