/**
 * App development deploy tools - deploy, clone.
 * @deprecated Legacy MCP tool registration. Domain logic in domains/dev/deploy.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../../utils.js';
import { doDeploy, doClone } from '../../domains/dev/deploy.js';
import { parseFileUri } from '@yaar/shared';

export type { DeployArgs, DeployResult, CloneResult } from '../../domains/dev/deploy.js';
export { doDeploy, doClone };

export function registerDeployTools(server: McpServer): void {
  // app_deploy - Deploy sandbox to apps/ directory
  server.registerTool(
    'deploy',
    {
      description: 'Deploy a sandbox as a desktop app. Auto-compiles if not already compiled.',
      inputSchema: {
        uri: z.string(),
        appId: z.string().describe('App ID (lowercase with hyphens)'),
        name: z.string().optional().describe('Display name'),
        description: z.string().optional().describe('Brief description of what the app does'),
        icon: z.string().optional().describe('Emoji icon'),
        createShortcut: z
          .boolean()
          .optional()
          .describe('Create desktop shortcut on deploy (default: true)'),
        keepSource: z.boolean().optional().describe('Include src/ in deployed app'),
        skill: z.string().optional().describe('Custom SKILL.md content (## Launch auto-appended)'),
        appProtocol: z
          .boolean()
          .optional()
          .describe('App Protocol support (auto-detected if omitted)'),
        version: z
          .string()
          .optional()
          .describe('Semantic version (e.g., "1.0.0"). Defaults to "1.0.0"'),
        author: z.string().optional().describe('Author name. Defaults to "YAAR"'),
        fileAssociations: z
          .array(
            z.object({
              extensions: z.array(z.string()),
              command: z.string(),
              paramKey: z.string(),
            }),
          )
          .optional()
          .describe('File types this app can open'),
        variant: z.enum(['standard', 'widget', 'panel']).optional().describe('Window variant type'),
        dockEdge: z.enum(['top', 'bottom']).optional().describe('Dock edge position'),
        frameless: z.boolean().optional().describe('Frameless window (no title bar)'),
        windowStyle: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Custom CSS properties for the window'),
        capture: z
          .enum(['auto', 'canvas', 'dom', 'svg', 'protocol'])
          .optional()
          .describe(
            'Screenshot capture strategy: canvas (toDataURL on largest canvas), dom (html2canvas), svg (serialize largest SVG), protocol (app provides its own screenshot), auto (default fallback chain)',
          ),
      },
    },
    async (args) => {
      const parsed = parseFileUri(args.uri);
      if (!parsed || parsed.authority !== 'sandbox' || !parsed.sandboxId) {
        return error('Expected a sandbox URI (e.g. yaar://sandbox/123).');
      }
      const result = await doDeploy(parsed.sandboxId, args);
      if (!result.success) return error(result.error);
      return ok(
        JSON.stringify(
          {
            success: true,
            appId: result.appId,
            name: result.name,
            icon: result.icon,
            message: `App "${result.name}" deployed! It will appear on the desktop.`,
          },
          null,
          2,
        ),
      );
    },
  );

  // clone - Clone deployed app source into a sandbox for editing
  server.registerTool(
    'clone',
    {
      description:
        "Clone an existing deployed app's source into a sandbox for editing. Use write or edit to modify, then compile and deploy back to the SAME appId to update the app in-place.",
      inputSchema: {
        appId: z.string().describe('The app ID to clone (folder name in apps/)'),
      },
    },
    async (args) => {
      const result = await doClone(args.appId);
      if (!result.success) return error(result.error);
      return ok(
        JSON.stringify(
          {
            sandboxId: result.sandboxId,
            appId: result.appId,
            files: result.files,
            message: `Cloned "${result.appId}" source into sandbox ${result.sandboxId}. Files are under src/. Use paths like "yaar://sandbox/${result.sandboxId}/src/main.ts" with write or edit, then compile and deploy back to appId="${result.appId}" to update the app in-place. Prefer splitting code into separate files (e.g., src/utils.ts, src/components.ts) and importing them from src/main.ts rather than putting everything in one file.`,
          },
          null,
          2,
        ),
      );
    },
  );
}
