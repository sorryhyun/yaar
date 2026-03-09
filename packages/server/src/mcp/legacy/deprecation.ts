/**
 * Deprecation tracking for legacy MCP tools.
 *
 * Logs a warning once per session per tool when a legacy named tool is used,
 * nudging toward verb-mode equivalents.
 */

const logged = new Set<string>();

/**
 * Log a deprecation warning for a legacy tool.
 * Only logs once per `${sessionId}:${toolName}` combination.
 */
export function logLegacyToolUsage(toolName: string, sessionId?: string): void {
  const key = `${sessionId ?? 'unknown'}:${toolName}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(
    `[MCP] Legacy tool "${toolName}" used (session: ${sessionId ?? 'unknown'}). ` +
      'This tool is deprecated — use verb mode equivalents instead.',
  );
}

/** Reset tracking (for tests). */
export function _resetDeprecationTracking(): void {
  logged.clear();
}
