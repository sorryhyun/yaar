/**
 * The skill topics, in a module free of `.md` text imports.
 *
 * The verb handler needs the list synchronously — it goes in the resource
 * description registered at startup — but importing it from `topics.ts` would pull
 * the text imports into the static module graph, which breaks vitest's resolution.
 * The list was therefore hand-copied into `handlers/skills.ts`, where nothing kept
 * the copy honest: it could name a topic that does not exist, or omit one that does,
 * and either way the only symptom is an agent told to read a document that is not
 * there. `topics.ts` now asserts the two agree at load.
 *
 * Each topic carries the situation it is for, which `list('yaar://skills')` returns
 * beside the name. That line is how an agent picks a topic, so it names the moment
 * ("the user wants…") rather than summarizing the document.
 */
export const TOPIC_WHEN = {
  components: "Building a window with renderer: 'component' — layout rules and component types",
  config: 'Changing hooks, settings, shortcuts, mounts or allowed domains',
  marketplace: 'Installing, updating or uninstalling an app by id',
  remote: 'The user wants to open YAAR from a phone, tablet or another computer',
  termux:
    'YAAR runs on an Android phone (Termux) and the user wants files from the phone — downloads, photos, documents',
} as const;

export type TopicName = keyof typeof TOPIC_WHEN;

export const TOPIC_NAMES = Object.keys(TOPIC_WHEN) as TopicName[];
