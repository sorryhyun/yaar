export {};
import { createSignal } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';
import type {
  ProjectMeta,
  FileEntry,
  Diagnostic,
  ConsoleEntry,
  StaticProtocolInfo,
  FileChange,
} from './types';

// Shared reactive state for the IDE.
//
// Signals only. Types live in ./types, the path helper lives in ../lib/paths.
// This module is the bottom of the dependency graph: it imports nothing
// app-local except its own type definitions, which is what keeps the layer
// rule (ui -> services -> lib -> core) enforceable by grep.

export const [activeProject, setActiveProject] = createSignal<ProjectMeta | null>(null);
export const [projects, setProjects] = createSignal<ProjectMeta[]>([]);
export const [files, setFiles] = createSignal<FileEntry[]>([]);
export const [openFilePath, setOpenFilePath] = createSignal<string | null>(null);
export const [openFileContent, setOpenFileContent] = createSignal<string | null>(null);
/**
 * Data URL for the open file when it is an image. Non-null means the editor shows
 * a picture instead of the textarea — an image's bytes are not editable source.
 */
export const [openFileImage, setOpenFileImage] = createSignal<string | null>(null);
export const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([]);
/**
 * The **bundler's** verdict on the last build. Bun builds straight through type
 * errors, so this says "it bundled", never "it is correct"; `compileStatus` combines
 * it with `typecheckState`. Nothing should read this signal alone and call the
 * project clean.
 */
export const [bundleStatus, setBundleStatus] = createSignal<
  'idle' | 'compiling' | 'success' | 'error'
>('idle');
/**
 * Whether type checking has run against the code as it stands now.
 *
 * `unknown` is the default after every write: a `clean` from before the last edit
 * describes code that no longer exists. It is a third answer, not a shade of `clean`.
 */
export const [typecheckState, setTypecheckState] = createSignal<'unknown' | 'clean' | 'errors'>(
  'unknown',
);
export const [compileErrors, setCompileErrors] = createSignal<string[]>([]);
export const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
export const [statusText, setStatusText] = createSignal('Ready');

export const [openTabs, setOpenTabs] = createSignal<string[]>([]);

export const [bundledLibs, setBundledLibs] = createSignal<string[]>([]);

export const [consoleLogs, setConsoleLogs] = createSignal<ConsoleEntry[]>([]);

export const [previewWindowId, setPreviewWindowId] = createSignal<string | null>(null);
/**
 * Which build the open preview is showing, against which build exists.
 *
 * `buildSerial` counts successful compiles; `previewBuildSerial` records the one the
 * preview window was last mounted from. They are equal when the preview shows current
 * code. They diverge only when a compile skipped the refresh
 * (`compile({ refreshPreview: false })`, which is how in-app state survives a build),
 * and that divergence must be *reported*: a preview silently showing the previous
 * build makes a screenshot confirm a fix that is not in it.
 */
export const [buildSerial, setBuildSerial] = createSignal(0);
export const [previewBuildSerial, setPreviewBuildSerial] = createSignal(0);

/** True when a preview is open and rendering a build older than the last compile. */
export function previewIsStale(): boolean {
  return previewWindowId() !== null && previewBuildSerial() < buildSerial();
}

const remoteChangeListeners: ((next: FileChange[], prev: FileChange[]) => void)[] = [];

/**
 * Recent file mutations, newest first and bounded by the recorder.
 *
 * Every write, edit, copy and delete lands here so the Changes tab can show the
 * diff. The before/after text is held because re-reading the file later shows only
 * its current state.
 *
 * Shared across copies of the window: the agent's edits run in whichever copy the
 * server picked to answer, which on a phone is the companion tab's, not the one on
 * screen.
 */
export const [fileChanges, setFileChanges] = createSharedSignal<FileChange[]>('changes', [], {
  onRemote: (next, prev) => remoteChangeListeners.forEach((fn) => fn(next, prev)),
});

/** Run `fn` when another copy of this window records changes. */
export function onRemoteFileChanges(fn: (next: FileChange[], prev: FileChange[]) => void): void {
  remoteChangeListeners.push(fn);
}
/** Which change the panel is showing. Null means "the newest one". */
export const [selectedChangeId, setSelectedChangeId] = createSignal<string | null>(null);

export const [staticProtocol, setStaticProtocol] = createSignal<StaticProtocolInfo | null>(null);
