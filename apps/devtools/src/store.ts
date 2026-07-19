export {};
import { createSignal } from '@bundled/solid-js';

// Shared reactive state for the IDE, plus the one path helper everything needs.
//
// Split out of project.ts so the signals have a single obvious home: project.ts,
// build.ts and the UI modules all read and write this state, and having it live
// inside the file that also performs project I/O made the ownership unclear.
// project.ts re-exports everything here, so existing `from './project'` imports
// keep working unchanged.

// ── Types ──

export interface ProjectMeta {
  id: string;
  name: string;
  lastModified: number;
}

export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ConsoleEntry {
  level: string;
  args: string[];
  timestamp: number;
}

// ── Signals ──

export const [activeProject, setActiveProject] = createSignal<ProjectMeta | null>(null);
export const [projects, setProjects] = createSignal<ProjectMeta[]>([]);
export const [files, setFiles] = createSignal<FileEntry[]>([]);
export const [openFilePath, setOpenFilePath] = createSignal<string | null>(null);
export const [openFileContent, setOpenFileContent] = createSignal<string | null>(null);
export const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([]);
export const [compileStatus, setCompileStatus] = createSignal<
  'idle' | 'compiling' | 'success' | 'error'
>('idle');
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

// ── Helpers ──

export function projectPath(projectId: string, sub?: string): string {
  return sub ? `projects/${projectId}/${sub}` : `projects/${projectId}`;
}
