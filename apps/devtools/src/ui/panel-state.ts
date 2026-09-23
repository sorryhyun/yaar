export {};
import { createSignal } from '@bundled/solid-js';
import { createPersistedSignal } from '@bundled/yaar';

// Shared view state for the workspace panes. Sidebar, Workspace and ChangeView must
// agree on which pane shows what, and none owns the others. This module imports
// nothing app-local; a shared signal in any one component would close an import cycle.

export type SidebarTab = 'files' | 'changes' | 'worker';
export type MainView = 'editor' | 'changes';
export type DiffViewMode = 'side-by-side' | 'unified';
export type ChangesMode = 'changes' | 'manual';
export type BottomTab = 'problems' | 'console';

/** Which list the left sidebar shows: the file tree or the change history. */
export const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>('files');

/** What fills the main pane above the bottom panel: the editor or a diff. */
export const [mainView, setMainView] = createSignal<MainView>('editor');

export const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>('unified');

/** The recorded-history diff, or the paste-two-texts comparison. */
export const [changesMode, setChangesMode] = createSignal<ChangesMode>('changes');

export const [bottomTab, setBottomTab] = createSignal<BottomTab>('problems');

/**
 * Whether the sidebar is pulled out over the editor. Only a narrow window (≤768px,
 * the SDK's `isNarrow`) has a drawer: there the sidebar leaves the grid so the
 * editor gets the whole width. A wide window lays the sidebar out beside the
 * editor and never reads this.
 */
export const [drawerOpen, setDrawerOpen] = createSignal(false);

/**
 * A position the editor should move its caret to once `path` is the open file. Set by
 * whoever opens a file at a location; the editor clears it after revealing.
 */
export const [pendingReveal, setPendingReveal] = createSignal<{
  path: string;
  line: number;
  column: number;
} | null>(null);

/** Collapsed leaves only the tab strip, whose badges still report counts. */
export const [bottomCollapsed, setBottomCollapsed] = createPersistedSignal(
  'preferences/bottom-panel-collapsed.json',
  false,
  { label: 'panel preferences' },
);

/** Bring a bottom-panel tab forward, expanding the panel if it was collapsed. */
export function showBottomTab(tab: BottomTab): void {
  setBottomTab(tab);
  setBottomCollapsed(false);
}

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

/**
 * Show the worker panel. The main pane goes back to the editor: the worker
 * cites files, and the editor is where a cited file opens — a lingering diff
 * would make every citation open somewhere the reader cannot see.
 */
export function showWorker(): void {
  setSidebarTab('worker');
  setMainView('editor');
}
