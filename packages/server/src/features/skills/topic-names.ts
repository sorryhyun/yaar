/**
 * The skill topic names, in a module free of `.md` text imports.
 *
 * The verb handler needs the list synchronously — it goes in the resource
 * description registered at startup — but importing it from `topics.ts` would pull
 * the text imports into the static module graph, which breaks vitest's resolution.
 * The list was therefore hand-copied into `handlers/skills.ts`, where nothing kept
 * the copy honest: it could name a topic that does not exist, or omit one that does,
 * and either way the only symptom is an agent told to read a document that is not
 * there. `topics.ts` now asserts the two agree at load.
 */
export const TOPIC_NAMES = ['components', 'config', 'marketplace', 'remote'] as const;

export type TopicName = (typeof TOPIC_NAMES)[number];
