/**
 * Sandbox domain handler for the verb layer.
 *
 * Registers:
 *   yaar://sandbox/eval — ephemeral JS execution
 *   yaar://sandbox/*    — sandbox file operations + dev pipeline
 */

import { parseFileUri, parseYaarUri } from '@yaar/shared';
import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, error, prependNote } from './utils.js';
import { formatSandboxResult } from '../features/sandbox/eval.js';
import {
  readSandboxFile,
  listSandboxFiles,
  writeSandboxFile,
  editSandboxFile,
  deleteSandboxFile,
} from '../features/sandbox/files.js';
import { doCompile, doTypecheck } from '../features/dev/compile.js';
import { doDeploy, doClone, type DeployArgs } from '../features/dev/deploy.js';

// ── Registration ──

export function registerSandboxHandlers(registry: ResourceRegistry): void {
  // ── yaar://sandbox/eval — ephemeral JS execution ──
  registry.register('yaar://sandbox/eval', {
    description:
      'Execute JavaScript code in a sandboxed environment. Code runs in an async IIFE (await supported).',
    verbs: ['describe', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 5000, min: 100, max: 30000)',
        },
      },
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (typeof payload?.code !== 'string' || !payload.code)
        return error('"code" (string) is required.');

      const timeout =
        typeof payload.timeout === 'number'
          ? Math.max(100, Math.min(30000, payload.timeout))
          : 5000;

      const { executeJs } = await import('../lib/sandbox/index.js');
      const { readAllowedDomains, isAllDomainsAllowed } =
        await import('../features/config/domains.js');

      const [allowedDomains, allowAllDomains] = await Promise.all([
        readAllowedDomains(),
        isAllDomainsAllowed(),
      ]);

      const result = await executeJs(payload.code, {
        timeout,
        allowedDomains,
        allowAllDomains,
      });

      return ok(formatSandboxResult(result, payload.code));
    },
  });

  // ── yaar://sandbox/* — sandbox file operations + dev pipeline ──
  registry.register('yaar://sandbox/*', {
    description:
      'Sandbox resource. Read/list files, invoke with action "write"/"edit" to modify files, ' +
      '"compile"/"typecheck" on sandbox root, "deploy" to publish as app, ' +
      '"clone" with uri to clone an app source. Use yaar://sandbox/new/{path} for auto-create.',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'edit', 'compile', 'typecheck', 'deploy', 'clone'],
        },
        content: { type: 'string', description: 'File content (for write or edit replacement)' },
        old_string: { type: 'string', description: 'Text to find (edit string mode)' },
        new_string: {
          type: 'string',
          description: 'Replacement text (edit); "content" also accepted',
        },
        start_line: {
          type: 'number',
          description: 'First line to replace (edit line mode, 1-based)',
        },
        end_line: {
          type: 'number',
          description: 'Last line to replace (edit line mode, 1-based, inclusive)',
        },
        title: { type: 'string', description: 'App title for compile/deploy' },
        appId: { type: 'string', description: 'App ID for deploy (lowercase with hyphens)' },
        name: { type: 'string', description: 'Display name (deploy)' },
        description: { type: 'string', description: 'App description (deploy)' },
        icon: { type: 'string', description: 'Emoji icon (deploy)' },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: 'URI prefixes the app iframe can access (deploy)',
        },
        uri: { type: 'string', description: 'Source app URI for clone (e.g. yaar://apps/my-app)' },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');

      if (parsed.sandboxId === null) {
        return error(
          'Cannot read from a new sandbox (yaar://sandbox/new/...). Provide a sandbox ID.',
        );
      }
      if (!parsed.path) {
        const listing = await listSandboxFiles(parsed.sandboxId);
        return prependNote(listing, 'This is a folder — used list instead.');
      }

      return readSandboxFile(parsed.sandboxId, parsed.path);
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');

      if (parsed.sandboxId === null) {
        return error('Cannot list a new sandbox. Provide a sandbox ID.');
      }

      return listSandboxFiles(parsed.sandboxId, parsed.path || undefined);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');
      if (!payload?.action) return error('Payload must include "action" ("write" or "edit").');

      const action = payload.action as string;

      if (action === 'write') {
        return writeSandboxFile(parsed.sandboxId, parsed.path, payload.content);
      }

      if (action === 'edit') {
        if (parsed.sandboxId === null) {
          return error('Cannot edit a new sandbox file. Write first, then edit.');
        }
        if (!parsed.path) return error('Provide a file path to edit.');
        return editSandboxFile(parsed.sandboxId, parsed.path, payload);
      }

      if (action === 'compile') {
        if (parsed.sandboxId === null) {
          return error('Cannot compile a new sandbox. Write files first.');
        }
        const result = await doCompile(parsed.sandboxId, { title: payload.title as string });
        if (!result.success) return error(result.error);
        return okJson({
          success: true,
          previewUrl: result.previewUrl,
          message: 'Compilation successful. Use create with renderer: "iframe" to preview.',
        });
      }

      if (action === 'typecheck') {
        if (parsed.sandboxId === null) {
          return error('Cannot typecheck a new sandbox. Write files first.');
        }
        const result = await doTypecheck(parsed.sandboxId);
        if (!result.success) return error(result.error);
        if (result.warnings?.length) {
          return ok(
            'Type check passed — no type errors found.\n\n⚠ Permission warnings:\n' +
              result.warnings.map((w) => `  • ${w}`).join('\n'),
          );
        }
        return ok('Type check passed — no errors found.');
      }

      if (action === 'deploy') {
        if (parsed.sandboxId === null) {
          return error('Cannot deploy a new sandbox. Write and compile first.');
        }
        const appId = payload.appId as string | undefined;
        if (!appId) return error('"appId" is required for deploy.');
        const result = await doDeploy(parsed.sandboxId, {
          appId,
          name: payload.name as string | undefined,
          description: payload.description as string | undefined,
          icon: payload.icon as string | undefined,
          permissions: payload.permissions as DeployArgs['permissions'],
        });
        if (!result.success) return error(result.error);
        return okJson({
          success: true,
          appId: result.appId,
          name: result.name,
          icon: result.icon,
          message: `App "${result.name}" deployed! It will appear on the desktop.`,
        });
      }

      if (action === 'clone') {
        const sourceUri = payload.uri as string | undefined;
        if (!sourceUri) return error('"uri" is required for clone (e.g. yaar://apps/my-app).');
        const sourceParsed = parseYaarUri(sourceUri);
        if (!sourceParsed || sourceParsed.authority !== 'apps' || !sourceParsed.path) {
          return error('Expected an app URI (e.g. yaar://apps/my-app).');
        }
        const appId = sourceParsed.path.split('/')[0];
        const result = await doClone(appId);
        if (!result.success) return error(result.error);
        return okJson({
          sandboxId: result.sandboxId,
          appId: result.appId,
          files: result.files,
          message: `Cloned "${result.appId}" into sandbox ${result.sandboxId}. Use yaar://sandbox/${result.sandboxId}/src/main.ts to edit.`,
        });
      }

      return error(
        `Unknown action "${action}". Use "write", "edit", "compile", "typecheck", "deploy", or "clone".`,
      );
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');

      if (parsed.sandboxId === null) {
        return error('Cannot delete from a new sandbox. Provide a sandbox ID.');
      }
      if (!parsed.path) return error('Provide a file path to delete.');

      return deleteSandboxFile(parsed.sandboxId, parsed.path);
    },
  });
}
