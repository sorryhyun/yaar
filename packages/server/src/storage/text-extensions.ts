/**
 * Which files storage will hand back as UTF-8 text.
 *
 * A leaf on purpose. Two doors need the same answer — `storageRead`, deciding whether to
 * decode bytes or refuse them, and window creation, deciding whether a `yaar://storage/…`
 * named as a markdown window's content can become that window's text (features/window/
 * inline-content.ts) — and a second copy of the list is how the two start disagreeing
 * about `.csv`.
 *
 * It lives here rather than being exported from `storage-manager.ts` because several
 * suites `mock.module` that file with a hand-written stub; a new export there is missing
 * from every stub the moment it is added, and the failure is an import error in a suite
 * that has nothing to do with the change.
 */
import { extname } from 'path';

/** Extensions known to be safe to read as UTF-8 text */
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.jsonl',
  '.html', '.htm', '.xml', '.svg',
  '.css', '.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx', '.jsx',
  '.yaml', '.yml', '.toml', '.ini', '.env', '.conf', '.cfg',
  '.sh', '.bash', '.zsh', '.fish',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.log', '.diff', '.patch',
]);

export function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}
