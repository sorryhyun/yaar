export {};
import { createSignal } from '@bundled/solid-js';

// Shared view state for the workspace panes.
//
// The Changes view is no longer a bottom-panel tab: the change list lives beside
// the file tree (same sidebar, second tab) and its diff takes the editor area, so
// a changed file is read in the same place a file is read. Three components have
// to agree on which pane is showing what — Sidebar, Workspace and ChangeView — and
// none of them owns the others, so the signals live here rather than in any one of
// them. This module imports nothing app-local, which is what keeps it free of the
// import cycle a shared signal in either component would have closed.

export type SidebarTab = 'files' | 'changes';
export type MainView = 'editor' | 'changes';
export type DiffViewMode = 'side-by-side' | 'unified';
export type ChangesMode = 'changes' | 'manual';

/** Which list the left sidebar shows: the file tree or the change history. */
export const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>('files');

/** What fills the main pane above the bottom panel: the editor or a diff. */
export const [mainView, setMainView] = createSignal<MainView>('editor');

export const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>('unified');

/** The recorded-history diff, or the paste-two-texts comparison. */
export const [changesMode, setChangesMode] = createSignal<ChangesMode>('changes');

/**
 * Show the file tree and the editor.
 *
 * Every path that opens a file calls this — the tree, and a click on a problem.
 * `openFile` itself cannot: it is a service, and services must not reach into UI
 * state. So the switch belongs at the call sites, and there are only two.
 */
export function showFiles(): void {
  setSidebarTab('files');
  setMainView('editor');
}

/** Show the change list and the diff of whichever change is selected. */
export function showChanges(): void {
  setSidebarTab('changes');
  setMainView('changes');
}
