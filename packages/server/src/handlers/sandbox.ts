/**
 * Sandbox domain handler for the verb layer.
 *
 * Registers:
 *   yaar://sandbox/eval — ephemeral JS execution
 *   yaar://sandbox/*    — sandbox file operations + dev pipeline
 */

import { stat, unlink, mkdir, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { parseFileUri, parseYaarUri } from '@yaar/shared';
import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { getSandboxPath } from '../lib/compiler/index.js';
import { generateSandboxId, isValidPath } from '../features/dev/helpers.js';
import { ok, okJson, error, validateRelativePath } from './utils.js';
import { doCompile, doTypecheck } from '../features/dev/compile.js';
import { doDeploy, doClone, type DeployArgs } from '../features/dev/deploy.js';
import { prependNote, applyEdit } from './utils.js';

// ── Helpers ──

function validateSandboxPath(path: string, sandboxPath: string): string | null {
  const pathErr = validateRelativePath(path);
  if (pathErr) return pathErr;
  if (!isValidPath(sandboxPath, path)) {
    return 'Path escapes sandbox directory.';
  }
  return null;
}

async function listFiles(dir: string, base: string): Promise<string[]> {
  const { relative } = await import('path');
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, base)));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

// ── Sandbox eval helpers ──

/** Common sandbox-escape patterns -> short hint */
const SANDBOX_HINTS: [RegExp, string][] = [
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
function formatSandboxResult(result: any, code: string): string {
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
      if (!parsed.path)
        return this.list!(resolved).then((r) =>
          prependNote(r, 'This is a folder — used list instead.'),
        );

      const sandboxPath = getSandboxPath(parsed.sandboxId);
      const pathErr = validateSandboxPath(parsed.path, sandboxPath);
      if (pathErr) return error(pathErr);

      const fullPath = join(sandboxPath, parsed.path);

      try {
        const info = await stat(fullPath);
        if (info.isDirectory())
          return this.list!(resolved).then((r) =>
            prependNote(r, 'This is a folder — used list instead.'),
          );
        const content = await Bun.file(fullPath).text();
        const lines = content.split('\n');
        const width = String(lines.length).length;
        const numbered = lines
          .map((line, i) => `${String(i + 1).padStart(width)}│${line}`)
          .join('\n');
        return ok(`── ${parsed.path} (${lines.length} lines) ──\n${numbered}`);
      } catch {
        return error(`File not found: ${parsed.path}`);
      }
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');

      if (parsed.sandboxId === null) {
        return error('Cannot list a new sandbox. Provide a sandbox ID.');
      }

      const sandboxPath = getSandboxPath(parsed.sandboxId);

      try {
        const targetDir = parsed.path ? join(sandboxPath, parsed.path) : sandboxPath;
        if (parsed.path) {
          const pathErr = validateSandboxPath(parsed.path, sandboxPath);
          if (pathErr) return error(pathErr);
        }
        const files = await listFiles(targetDir, sandboxPath);
        return okJson({ sandboxId: parsed.sandboxId, files });
      } catch {
        return error(`Sandbox not found: ${parsed.sandboxId}`);
      }
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed || parsed.authority !== 'sandbox') return error('Invalid sandbox URI.');
      if (!payload?.action) return error('Payload must include "action" ("write" or "edit").');

      const action = payload.action as string;

      if (action === 'write') {
        let sandboxId: string;
        if (parsed.sandboxId === null) {
          if (!parsed.path)
            return error('Provide a file path (e.g. yaar://sandbox/new/src/main.ts).');
          sandboxId = generateSandboxId();
        } else {
          if (!parsed.path) return error('Provide a file path within the sandbox.');
          sandboxId = parsed.sandboxId;
        }

        if (typeof payload.content !== 'string')
          return error('"content" (string) is required for write.');

        const sandboxPath = getSandboxPath(sandboxId);
        const pathErr = validateSandboxPath(parsed.path, sandboxPath);
        if (pathErr) return error(pathErr);

        const fullPath = join(sandboxPath, parsed.path);
        try {
          await mkdir(dirname(fullPath), { recursive: true });
          await Bun.write(fullPath, payload.content);
          return okJson({
            sandboxId,
            path: parsed.path,
            message: `Written to yaar://sandbox/${sandboxId}/${parsed.path}`,
          });
        } catch (err) {
          return error(err instanceof Error ? err.message : 'Unknown error');
        }
      }

      if (action === 'edit') {
        if (parsed.sandboxId === null) {
          return error('Cannot edit a new sandbox file. Write first, then edit.');
        }
        if (!parsed.path) return error('Provide a file path to edit.');

        const sandboxPath = getSandboxPath(parsed.sandboxId);
        const pathErr = validateSandboxPath(parsed.path, sandboxPath);
        if (pathErr) return error(pathErr);

        const fullPath = join(sandboxPath, parsed.path);
        let content: string;
        try {
          content = await Bun.file(fullPath).text();
        } catch {
          return error(`File not found: ${parsed.path}`);
        }

        const edited = await applyEdit(content, payload);
        if ('error' in edited) return error(edited.error);

        await Bun.write(fullPath, edited.result);
        return okJson({
          sandboxId: parsed.sandboxId,
          path: parsed.path,
          message: `Edited yaar://sandbox/${parsed.sandboxId}/${parsed.path}`,
        });
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

      const sandboxPath = getSandboxPath(parsed.sandboxId);
      const pathErr = validateSandboxPath(parsed.path, sandboxPath);
      if (pathErr) return error(pathErr);

      const fullPath = join(sandboxPath, parsed.path);
      try {
        await unlink(fullPath);
        return ok(`Deleted yaar://sandbox/${parsed.sandboxId}/${parsed.path}`);
      } catch {
        return error(`File not found: ${parsed.path}`);
      }
    },
  });
}
