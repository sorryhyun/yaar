/**
 * App development helpers - path validation, naming.
 */

import { join, normalize, relative } from 'path';

/**
 * Validate path to prevent directory traversal.
 */
export function isValidPath(basePath: string, targetPath: string): boolean {
  const normalizedTarget = normalize(join(basePath, targetPath));
  const relativePath = relative(basePath, normalizedTarget);
  return !relativePath.startsWith('..') && !relativePath.includes('..');
}

/**
 * Generate a sandbox ID using current timestamp.
 */
export function generateSandboxId(): string {
  return Date.now().toString();
}

/**
 * Convert app ID to display name.
 * kebab-case or snake_case → Title Case
 */
export function toDisplayName(appId: string): string {
  return appId
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
