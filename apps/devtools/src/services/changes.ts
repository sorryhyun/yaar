export {};
import { batch } from '@bundled/solid-js';
import {
  activeProject,
  openFilePath,
  setOpenFileContent,
  setOpenFileImage,
  setOpenFilePath,
  onRemoteFileChanges,
  fileChanges,
  setFileChanges,
  selectedChangeId,
  setSelectedChangeId,
  type FileChange,
  type FileChangeKind,
} from '../core';
import { diffStats } from '../lib';
import { refreshFiles } from './files';

// Records what each file mutation did, so the Changes panel can render a diff.
// Every writer in services/files.ts funnels through recordChange; a mutation that
// skips it is invisible to the user.

/**
 * How many changes to keep.
 *
 * Each entry holds two full copies of a file, so this is a memory budget, not a
 * UI one. Forty covers a working session's worth of edits at a few hundred KB.
 */
const MAX_CHANGES = 40;

let sequence = 0;

export interface RecordChangeInput {
  path: string;
  kind: FileChangeKind;
  before: string;
  after: string;
  label: string;
}

/**
 * Push a change onto the history and select it, returning what was recorded.
 *
 * A write whose content matches what was already there is dropped rather than
 * recorded as an empty diff: the file list refreshes and the status line still
 * reports it, but an entry that renders no lines only buries the ones that do.
 * The single exception is a delete, which genuinely removes an empty file.
 */
export function recordChange(input: RecordChangeInput): FileChange | null {
  if (input.before === input.after && input.kind !== 'delete') return null;
  const { added, removed } = diffStats(input.before, input.after);
  sequence += 1;
  const change: FileChange = {
    id: `chg-${Date.now()}-${sequence}`,
    projectId: activeProject()?.id,
    ...input,
    added,
    removed,
    timestamp: Date.now(),
  };
  // Follow the newest change only when the user is already looking at the newest
  // one. Someone reading an older diff while a batch of edits lands keeps their
  // place instead of being yanked forward on every write.
  const previous = fileChanges();
  const following = selectedChangeId() === null || selectedChangeId() === previous[0]?.id;
  batch(() => {
    setFileChanges([change, ...previous].slice(0, MAX_CHANGES));
    if (following) setSelectedChangeId(change.id);
  });
  return change;
}

export function clearChanges(): void {
  batch(() => {
    setFileChanges([]);
    setSelectedChangeId(null);
  });
}

export function selectChange(id: string): void {
  setSelectedChangeId(id);
}

/**
 * The change the panel should show: the selected one, or the newest when the
 * selection is empty or points at an entry that has aged out of the history.
 */
export function currentChange(): FileChange | null {
  const list = fileChanges();
  const id = selectedChangeId();
  return list.find((c) => c.id === id) ?? list[0] ?? null;
}

/**
 * Catch up on changes another copy of this window made.
 *
 * The history itself arrives through the shared signal. What does not is everything
 * else the writing copy did alongside it — its editor buffer, its file list — so this
 * copy redoes those for the project it has open, and keeps following the newest entry
 * the same way `recordChange` does. The typecheck reset is not redone: that verdict is
 * itself shared, and resetting it from here would overwrite the writing copy's next
 * typecheck with a stale `unknown`.
 */
onRemoteFileChanges((next, prev) => {
  const known = new Set(prev.map((c) => c.id));
  const arrived = next.filter((c) => !known.has(c.id));
  const selected = selectedChangeId();
  if (selected === null || selected === prev[0]?.id || !next.some((c) => c.id === selected)) {
    setSelectedChangeId(next[0]?.id ?? null);
  }

  const projectId = activeProject()?.id;
  const touched = arrived.filter((c) => c.projectId === projectId);
  if (!projectId || touched.length === 0) return;
  const openPath = openFilePath();
  // Oldest first, so the newest change to the open file is the one that sticks.
  for (const change of [...touched].reverse()) {
    if (change.path !== openPath) continue;
    if (change.kind === 'delete') {
      batch(() => {
        setOpenFilePath(null);
        setOpenFileContent(null);
        setOpenFileImage(null);
      });
    } else {
      setOpenFileContent(change.after);
    }
  }
  void refreshFiles(projectId);
});
