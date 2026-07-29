/**
 * System domain handlers for the verb layer — the running installation itself.
 *
 *   list('yaar://system')                              → available system resources
 *   read('yaar://system/update')                       → cached status + live install progress
 *   invoke('yaar://system/update', { action: 'check' })   → ask GitHub for the latest release
 *   invoke('yaar://system/update', { action: 'install' }) → download, verify, and swap it in
 *
 * `read` is deliberately network-free so a UI can poll it during an install; only
 * `check` goes out. See `features/update/updater.ts` for the reasoning behind that
 * split and behind `install` returning before the work finishes.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import { ok, okJson, okLinks, error } from './utils.js';
import {
  checkForUpdate,
  getUpdateStatus,
  refusalText,
  startInstall,
  UpdateRefused,
} from '../features/update/updater.js';

export function registerSystemHandlers(registry: ResourceRegistry): void {
  // ── yaar://system — namespace root ──
  registry.register('yaar://system', {
    description: 'The running YAAR installation — version and updates.',
    verbs: ['describe', 'list'],

    async list() {
      return okLinks([
        {
          uri: 'yaar://system/update',
          name: 'update',
          description: 'Running version, latest release, and self-update',
        },
      ]);
    },
  });

  // ── yaar://system/update — version check + self-update ──
  registry.register('yaar://system/update', {
    description:
      'YAAR version and updates. Read for the running version plus the last check result and any install in progress (no network). Invoke with action "check" to ask GitHub for the latest release, or "install" to download it, verify it against the release SHA256SUMS, and swap it in. Only the standalone executable can install updates; a source checkout updates with git. Installing never restarts YAAR — the user must do that.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'install'],
          description:
            '"check" queries GitHub for the latest release; "install" downloads and applies it.',
        },
        force: {
          type: 'boolean',
          description: 'check only — bypass the 5-minute result cache.',
        },
      },
      required: ['action'],
    },

    async read(): Promise<VerbResult> {
      return okJson(getUpdateStatus());
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const action = (payload as { action?: string } | undefined)?.action;
      const force = (payload as { force?: boolean } | undefined)?.force === true;

      if (action === 'check') {
        const status = await checkForUpdate(force);
        return okJson(status);
      }

      if (action === 'install') {
        try {
          return okJson(await startInstall());
        } catch (err) {
          if (err instanceof UpdateRefused) return error(err.message);
          throw err;
        }
      }

      if (action === 'status') {
        // Not in the schema, but a plausible guess — answer it rather than scolding.
        return okJson(getUpdateStatus());
      }

      return error('Provide action: "check" or "install".');
    },

    async describe() {
      // The generated describe would list the verbs but not say whether *this* build
      // can act on them, which is the first thing a caller needs to know.
      const status = getUpdateStatus();
      const capability = status.canInstall
        ? 'This build can install updates itself.'
        : refusalText(status);
      return ok(
        JSON.stringify(
          {
            uri: 'yaar://system/update',
            description: `Running ${status.current} (${status.bundled ? 'standalone executable' : 'source checkout'}) on ${status.platform}/${status.arch}. ${capability}`,
            verbs: ['describe', 'read', 'invoke'],
            invokeSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['check', 'install'] },
                force: { type: 'boolean' },
              },
              required: ['action'],
            },
          },
          null,
          2,
        ),
      );
    },
  });
}
