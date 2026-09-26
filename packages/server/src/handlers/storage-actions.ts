/**
 * What each storage invoke action does, written once for both doors onto the storage tree.
 *
 * `yaar://storage/…` (handlers/storage.ts) and `yaar://apps/{id}/storage/…`
 * (handlers/apps/storage-resource.ts) each dispatch from their own `defineActions` table —
 * their cases differ (paths are prefixed, subscribers notified, `edit` and `share` exist on
 * only one) — and every list of their actions is derived from those tables: the schema
 * enums, the composite `yaar://apps/*` enum, the `describe` prose. What the two tables
 * share is the meaning of an action, and that is here, so `copy` is not explained two
 * different ways depending on which door the caller came through.
 */

export const STORAGE_ACTION_DOCS = {
  write: 'Write "content" to this path (add "encoding": "base64" for binary).',
  copy:
    'Copy the file at "from" (a yaar:// storage URI) to this path. The bytes move ' +
    'server-side — prefer it to reading a file and writing it back.',
  edit:
    'Edit this text file: replace "old_string" with "new_string", or lines ' +
    '"start_line".."end_line" with "new_string".',
  grep: 'Search the files under this path for regex "pattern", optionally narrowed by "glob".',
  extract: 'Unpack the archive at "from" into this (new) folder.',
  compress: 'Pack "from" (a file or folder, or an array of them) into the archive this URI names.',
  share: "Open Android's share sheet for this file; the user picks the app it goes to.",
} as const;
