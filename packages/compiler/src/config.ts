/**
 * Compiler configuration — initialized by the host (server or CLI).
 */

export interface CompilerConfig {
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Whether running as a bundled executable (no node_modules). */
  isBundledExe: boolean;
}

let _config: CompilerConfig | null = null;

/**
 * Initialize the compiler with host-provided configuration.
 * Must be called before any compile/typecheck operations.
 */
export function initCompiler(config: CompilerConfig): void {
  _config = config;
}

/**
 * Get the current compiler configuration.
 * Throws if initCompiler() has not been called.
 */
export function getCompilerConfig(): CompilerConfig {
  if (!_config) {
    throw new Error('Compiler not initialized. Call initCompiler() first.');
  }
  return _config;
}
