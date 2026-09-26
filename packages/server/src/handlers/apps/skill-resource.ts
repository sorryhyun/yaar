/**
 * `yaar://apps/{appId}/skill` — the app's hand-written manual (`agent/SKILL.md`), whole.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts`, like the
 * protocol and docs resources beside it. Each entry point returns `null` for a non-skill
 * URI so the composite can fall through.
 *
 * ## Why this resource exists
 *
 * `describe("yaar://apps/{id}")` used to carry SKILL.md verbatim, as one JSON string. A
 * model does not read YAAR's text block — the CLI hands it `JSON.stringify(structuredContent)`
 * (see `okJson`) — so the manual arrived as a single line of `\n` and `\"` escapes: a
 * markdown document with its structure flattened into punctuation. Describe now carries
 * the manual's section headings and names this URI, where `read` returns the file as a
 * `text/markdown` resource, newlines and all.
 *
 * One document, not a collection: `read` is the only verb that answers with content.
 */

import { okJson, okResource, error, type VerbResult } from '../../lib/verb-result.js';
import { listApps, loadAppSkill } from '../../features/apps/discovery.js';
import { skillSections } from '../../features/apps/describe.js';
import { parseAppSkillPath } from './paths.js';

/** The app's SKILL.md, or the refusal that explains why there isn't one. */
async function loadSkill(appId: string): Promise<string | VerbResult> {
  const apps = await listApps();
  if (!apps.some((a) => a.id === appId)) return error(`App "${appId}" not found.`);
  const skill = await loadAppSkill(appId);
  if (!skill) {
    return error(
      `App "${appId}" ships no SKILL.md (agent/SKILL.md). ` +
        `describe("yaar://apps/${appId}") for what it does document.`,
    );
  }
  return skill;
}

/** `describe` — what the manual covers, not what it says. */
export async function describeAppSkill(uri: string): Promise<VerbResult | null> {
  const parsed = parseAppSkillPath(uri);
  if (!parsed) return null;
  const skill = await loadSkill(parsed.appId);
  if (typeof skill !== 'string') return skill;
  return okJson({
    uri,
    sections: skillSections(skill),
    bytes: skill.length,
    verbs: ['describe', 'read'],
    read: `read("${uri}") — the manual in full, markdown.`,
  });
}

/** `read` — the manual itself. */
export async function readAppSkill(uri: string): Promise<VerbResult | null> {
  const parsed = parseAppSkillPath(uri);
  if (!parsed) return null;
  const skill = await loadSkill(parsed.appId);
  if (typeof skill !== 'string') return skill;
  return okResource(uri, skill, 'text/markdown');
}

/**
 * Everything but `describe`/`read`. The manual is one document — nothing to list — and it
 * is part of the app's source, so the refusal points at where it is edited.
 */
export function rejectSkillVerb(
  uri: string,
  verb: 'list' | 'invoke' | 'delete',
): VerbResult | null {
  const parsed = parseAppSkillPath(uri);
  if (!parsed) return null;
  return error(
    verb === 'list'
      ? `"${uri}" is one document, not a collection. Use read("${uri}").`
      : `Cannot ${verb} "${uri}" — SKILL.md is part of the app's source (agent/SKILL.md). ` +
          "Edit the file in the app's tree and redeploy.",
  );
}
