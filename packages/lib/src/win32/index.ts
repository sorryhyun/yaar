/**
 * Win32 calls through `bun:ffi`, for the few places where one system call replaces a
 * PowerShell round trip. Not a general bindings layer — see docs/proposals/windows_proposal.md.
 */
export { readProcessCommandLine } from './process-command-line.js';
