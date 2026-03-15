/**
 * Sandbox eval helpers — hint matching and result formatting.
 */

/** Common sandbox-escape patterns -> short hint */
export const SANDBOX_HINTS: [RegExp, string][] = [
  [
    /\brequire\b/,
    'require() is not available. This sandbox uses ESM — only built-in globals and fetch (for allowed domains) are provided.',
  ],
  [/\bDeno\b/, 'Deno APIs are not available. This is a Node.js vm sandbox, not Deno.'],
  [
    /\b(readFile|writeFile|readdir)\b/,
    'Node.js fs APIs are not available in the sandbox. Use storage tools for file access.',
  ],
  [/\bprocess\b/, 'process is not available. The sandbox has no access to the host environment.'],
  [/\bimport\s*\(/, 'Dynamic import() is not available in the sandbox.'],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatSandboxResult(result: any, code: string): string {
  const parts: string[] = [];

  if (result.logsFormatted) {
    parts.push('Console output:');
    parts.push(result.logsFormatted);
    parts.push('');
  }

  if (result.success) {
    parts.push(`Result: ${result.result !== undefined ? result.result : 'undefined'}`);
  } else {
    parts.push(`Error: ${result.error}`);

    if (result.error?.includes('is not defined') || result.error?.includes('is not a function')) {
      for (const [pattern, hint] of SANDBOX_HINTS) {
        if (pattern.test(code)) {
          parts.push(`Hint: ${hint}`);
          break;
        }
      }
    }
  }

  parts.push(`Execution time: ${Math.round(result.executionTimeMs)}ms`);
  return parts.join('\n');
}
