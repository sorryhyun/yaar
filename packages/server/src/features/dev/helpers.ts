/**
 * App development helpers - path validation, naming, SKILL.md generation.
 */

import { readdir } from 'fs/promises';
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

/**
 * Generate the Launch section based on what the app has.
 * - Compiled apps (index.html) → invoke create on yaar://windows/
 * - Component apps (.yaarcomponent.json) → invoke create with renderer: "component" on yaar://windows/
 * - Both → shows both options
 */
function generateLaunchSection(
  appId: string,
  appName: string,
  hasCompiledApp: boolean,
  componentFiles: string[] = [],
): string {
  const parts: string[] = ['## Launch'];

  if (hasCompiledApp) {
    parts.push(`Open this app in an iframe window:
\`\`\`
invoke('yaar://windows/${appId}', {
  action: "create",
  title: "${appName}",
  renderer: "iframe",
  content: "yaar://apps/${appId}"
})
\`\`\``);
  }

  if (componentFiles.length > 0) {
    for (const f of componentFiles) {
      parts.push(`\`\`\`
invoke('yaar://windows/', {
  action: "create",
  renderer: "component",
  jsonfile: "${appId}/${f}",
  title: "${appName}"
})
\`\`\``);
    }
  }

  return parts.join('\n');
}

/**
 * Generate SKILL.md content for a deployed app.
 * If customSkill is provided, uses it as the base and appends launch/source sections.
 * Otherwise generates a default template.
 */
export function generateSkillMd(
  appId: string,
  appName: string,
  hasCompiledApp: boolean,
  componentFiles: string[] = [],
  customSkill?: string,
  hasProtocol?: boolean,
): string {
  const launchSection = generateLaunchSection(appId, appName, hasCompiledApp, componentFiles);
  let md: string;

  if (customSkill) {
    md = customSkill.trimEnd() + '\n\n' + launchSection + '\n';
  } else {
    md = `# ${appName}

${hasCompiledApp ? 'A compiled TypeScript application.' : 'A component-based application.'}

${launchSection}
`;
  }

  if (hasProtocol) {
    md += `
## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
\`\`\`
invoke('yaar://windows/${appId}', { action: "app_query" })
\`\`\`

Use \`app_query\` to discover available state and commands. Then query state with \`invoke('yaar://windows/${appId}', { action: "app_query", stateKey: "..." })\` and run commands with \`invoke('yaar://windows/${appId}', { action: "app_command", command: "...", params: {...} })\`.
`;
  }

  return md;
}

/**
 * Regenerate SKILL.md for a deployed app, preserving custom content above ## Launch.
 */
export async function regenerateSkillMd(appId: string, appPath: string): Promise<void> {
  // Read existing SKILL.md to preserve custom content
  let customContent: string | undefined;
  try {
    const existing = await Bun.file(join(appPath, 'SKILL.md')).text();
    // Extract everything before ## Launch
    const launchIdx = existing.indexOf('## Launch');
    if (launchIdx > 0) {
      customContent = existing.slice(0, launchIdx).trimEnd();
    }
  } catch {
    // No existing SKILL.md
  }

  // Detect what the app has
  let hasCompiledApp = false;
  let hasProtocolJson = false;
  try {
    await Bun.file(join(appPath, 'dist', 'index.html')).text();
    hasCompiledApp = true;
  } catch {
    /* no compiled app */
  }
  try {
    await Bun.file(join(appPath, 'dist', 'protocol.json')).text();
    hasProtocolJson = true;
  } catch {
    /* no dist/protocol.json */
  }

  const componentFiles: string[] = [];
  try {
    const files = await readdir(appPath);
    for (const f of files) {
      if (f.endsWith('.yaarcomponent.json')) componentFiles.push(f);
    }
  } catch {
    /* readdir failure */
  }

  // Read display name from app.json
  let displayName = toDisplayName(appId);
  try {
    const meta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
    if (meta.name) displayName = meta.name;
  } catch {
    /* no app.json */
  }

  const skillContent = generateSkillMd(
    appId,
    displayName,
    hasCompiledApp,
    componentFiles,
    customContent,
    hasProtocolJson,
  );
  await Bun.write(join(appPath, 'SKILL.md'), skillContent);
}
