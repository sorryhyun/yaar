/**
 * The pure half of the app docs tier: the frontmatter grammar and the slug rule.
 *
 * A leaf on purpose — no imports at all — because it has two readers with different
 * runtimes: `docs.ts` (the server, loading topics through the app roots) and
 * `scripts/check/apps.ts` (the repo lint, which must not drag in the server's config
 * bootstrap just to validate a markdown header). One parser for both is what keeps
 * "valid to the lint" and "valid to the runtime" the same predicate.
 */

/** Where an app's topic files live, relative to the app root. Not overridable —
 * unlike the single-file agent docs there is no legacy location to honor. */
export const AGENT_DOCS_DIR = 'agent/docs';

/** The slug rule: what a topic's `name` must look like to be addressable. */
export const DOC_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The ceiling on a topic's `description`. The line is the topic's entire always-loaded
 * footprint — one row in every index the platform generates — so past this length it is
 * a summary pretending to be a trigger.
 */
export const DOC_DESCRIPTION_MAX = 150;

export type AppDocAudience = 'agent' | 'dev' | 'both';

export const DOC_AUDIENCES: readonly AppDocAudience[] = ['agent', 'dev', 'both'];

/**
 * Parse the frontmatter subset a topic file may carry.
 *
 * Deliberately not a YAML parser: the schema is four keys, three of them one-line
 * scalars and one a list of plain paths. Anything fancier in a frontmatter block is an
 * authoring error the check script should catch, not a shape the runtime should honor.
 * Returns the fields it recognized plus the body with the block stripped; a file with
 * no block at all is `{ fields: {}, body: content }`.
 */
export function parseDocFrontmatter(content: string): {
  fields: Record<string, string | string[]>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: content };

  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      (fields[listKey] as string[]).push(item[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') {
      fields[key] = [];
      listKey = key;
    } else {
      fields[key] = value.trim();
      listKey = null;
    }
  }
  return { fields, body: content.slice(match[0].length) };
}
