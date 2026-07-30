export {};
import { createSignal } from '@bundled/solid-js';
import type { ProjectMeta, FileEntry, Diagnostic, ConsoleEntry, StaticProtocolInfo } from './types';

// Shared reactive state for the IDE.
//
// Signals only. Types live in ./types, the path helper lives in ../lib/paths.
// This module is the bottom of the dependency graph: it imports nothing
// app-local except its own type definitions, which is what keeps the layer
// rule (ui -> services -> lib -> core) enforceable by grep.

// ── Signals ──

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
 * The **bundler's** verdict on the last build. Deliberately not the whole story:
 * Bun strips types and builds straight through type errors, so this says "it
 * bundled", never "it is correct". `bundleStatus`/`compileStatus` in the protocol
 * are what combine it with `typecheckState` — nothing should read this signal alone
 * and call the project clean.
 */
export const [bundleStatus, setBundleStatus] = createSignal<
  'idle' | 'compiling' | 'success' | 'error'
>('idle');
/**
 * Whether type checking has run against the code as it stands now.
 *
 * `unknown` is the load-bearing value, and it is the default after every write: a
 * `clean` from before the last edit describes code that no longer exists, and
 * reporting it as still clean is the exact failure `compileStatus` was making with
 * the bundler's verdict. It is a third answer, not a shade of one of the other two.
 */
export const [typecheckState, setTypecheckState] = createSignal<'unknown' | 'clean' | 'errors'>(
  'unknown',
);
export const [compileErrors, setCompileErrors] = createSignal<string[]>([]);
export const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
export const [statusText, setStatusText] = createSignal('Ready');

// ── Feature: Multi-Project Tabs ──
export const [openTabs, setOpenTabs] = createSignal<string[]>([]);

// ── Feature: Bundled Libraries ──
export const [bundledLibs, setBundledLibs] = createSignal<string[]>([]);

// ── Feature: Console Capture ──
export const [consoleLogs, setConsoleLogs] = createSignal<ConsoleEntry[]>([]);

// ── Feature: Preview Window ──
export const [previewWindowId, setPreviewWindowId] = createSignal<string | null>(null);

// ── Feature: Static protocol manifest (from the last successful compile) ──
export const [staticProtocol, setStaticProtocol] = createSignal<StaticProtocolInfo | null>(null);
