/**
 * App development helpers - naming.
 */

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
