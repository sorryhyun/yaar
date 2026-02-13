/**
 * App development helpers - path validation, naming, SKILL.md generation.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
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
 * - Compiled apps (index.html) → iframe create()
 * - Component apps (.yaarcomponent.json) → create_component(jsonfile)
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
create({
  windowId: "${appId}",
  title: "${appName}",
  renderer: "iframe",
  content: "/api/apps/${appId}/static/index.html"
})
\`\`\``);
  }

  if (componentFiles.length > 0) {
    for (const f of componentFiles) {
      const windowName = f.replace('.yaarcomponent.json', '');
      parts.push(
        `\`create_component(jsonfile="${appId}/${f}", windowId="${appId}-${windowName}", title="${appName}")\``,
      );
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
  hasAppProtocol?: boolean,
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

  md += `\n## Source
Source code is available in \`src/\` directory. Use \`read_config\` with path \`src/main.ts\` to view.
`;

  if (hasAppProtocol) {
    md += `
## App Protocol

This app supports the App Protocol for programmatic interaction.

### Discover capabilities
\`\`\`
app_query({ windowId: "${appId}", stateKey: "manifest" })
\`\`\`

Use \`app_query\` with stateKey \`"manifest"\` to discover available state queries and commands, then use \`app_query\` and \`app_command\` to interact with the app.
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
    const existing = await readFile(join(appPath, 'SKILL.md'), 'utf-8');
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
  let hasAppProtocol = false;
  try {
    const indexHtml = await readFile(join(appPath, 'index.html'), 'utf-8');
    hasCompiledApp = true;
    hasAppProtocol = indexHtml.includes('.app.register');
  } catch {
    /* no compiled app */
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
    const meta = JSON.parse(await readFile(join(appPath, 'app.json'), 'utf-8'));
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
    hasAppProtocol,
  );
  await writeFile(join(appPath, 'SKILL.md'), skillContent, 'utf-8');
}
