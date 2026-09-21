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
  SharedOpenFile,
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

// The `createSharedSignal`s in this file are held by the server per window and
// followed by every copy of it (see `fileChanges` for why copies exist). What a
// command produces — a build, a type check, the preview binding — is shared as data,
// because a copy that did not run the command has no way to recompute it. Write them
// only where the thing they describe happens: a copy catching up with another must
// not write them back.

const remoteOpenFileListeners: ((next: SharedOpenFile | null) => void)[] = [];

/**
 * Which file the editor has open, as a pointer rather than as content: every copy
 * reads the same storage, so a copy that follows loads the file itself. The three
 * signals above stay per copy, which keeps each copy's path and buffer in step.
 */
export const [sharedOpenFile, setSharedOpenFile, sharedOpenFileReady] =
  createSharedSignal<SharedOpenFile | null>('open-file', null, {
    onRemote: (next) => remoteOpenFileListeners.forEach((fn) => fn(next)),
  });

/** Run `fn` when another copy of this window opens a file. */
export function onRemoteOpenFile(fn: (next: SharedOpenFile | null) => void): void {
  remoteOpenFileListeners.push(fn);
}

export const [diagnostics, setDiagnostics] = createSharedSignal<Diagnostic[]>('diagnostics', []);
/**
 * The **bundler's** verdict on the last build. Bun builds straight through type
 * errors, so this says "it bundled", never "it is correct"; `compileStatus` combines
 * it with `typecheckState`. Nothing should read this signal alone and call the
 * project clean.
 */
export const [bundleStatus, setBundleStatus] = createSharedSignal<
  'idle' | 'compiling' | 'success' | 'error'
>('bundle-status', 'idle');
/**
 * Whether type checking has run against the code as it stands now.
 *
 * `unknown` is the default after every write: a `clean` from before the last edit
 * describes code that no longer exists. It is a third answer, not a shade of `clean`.
 */
export const [typecheckState, setTypecheckState] = createSharedSignal<
  'unknown' | 'clean' | 'errors'
>('typecheck', 'unknown');
export const [compileErrors, setCompileErrors] = createSharedSignal<string[]>('compile-errors', []);
export const [previewUrl, setPreviewUrl] = createSharedSignal<string | null>('preview-url', null);
export const [statusText, setStatusText] = createSharedSignal('status', 'Ready');

export const [openTabs, setOpenTabs] = createSignal<string[]>([]);

export const [bundledLibs, setBundledLibs] = createSignal<string[]>([]);

/**
 * Not shared: every copy polls the open preview's console itself (services/console),
 * and sharing a buffer that refreshes every poll would be a write per tick per copy.
 */
export const [consoleLogs, setConsoleLogs] = createSignal<ConsoleEntry[]>([]);

export const [previewWindowId, setPreviewWindowId] = createSharedSignal<string | null>(
  'preview-window',
  null,
);

const remoteBuildListeners: (() => void)[] = [];

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
export const [buildSerial, setBuildSerial] = createSharedSignal('build-serial', 0, {
  onRemote: () => remoteBuildListeners.forEach((fn) => fn()),
});
export const [previewBuildSerial, setPreviewBuildSerial] = createSharedSignal(
  'preview-build-serial',
  0,
);

/** Run `fn` when another copy of this window finishes a successful compile. */
export function onRemoteBuild(fn: () => void): void {
  remoteBuildListeners.push(fn);
}

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

export const [staticProtocol, setStaticProtocol] = createSharedSignal<StaticProtocolInfo | null>(
  'static-protocol',
  null,
);
