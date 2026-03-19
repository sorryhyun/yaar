/**
 * User domain handlers for the verb layer.
 *
 * Maps user-facing operations to the verb layer:
 *
 *   invoke('yaar://sessions/current/notifications', { title, body, ... })  → show notification
 *   delete('yaar://sessions/current/notifications/{id}')                   → dismiss notification
 *   invoke('yaar://sessions/current/prompts', { action: 'ask', ... })      → ask user a question
 *   invoke('yaar://sessions/current/prompts', { action: 'request', ... })  → request user action
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error, assertUri, requireAction } from './utils.js';
import { showNotification, dismissNotification } from '../features/user/notifications.js';
import { askUser, requestUserInput } from '../features/user/prompts.js';

export function registerUserHandlers(registry: ResourceRegistry): void {
  // ── yaar://sessions/current/notifications — show/manage notifications ──
  registry.register('yaar://sessions/current/notifications', {
    description: 'Notifications. Invoke to show a new notification.',
    verbs: ['describe', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        id: { type: 'string', description: 'Unique notification ID (auto-generated if omitted)' },
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
        icon: { type: 'string', description: 'Optional icon' },
        duration: { type: 'number', description: 'Auto-dismiss after N milliseconds' },
      },
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload?.title) {
        return error('"title" is required.');
      }
      const result = showNotification({
        id: payload.id as string | undefined,
        title: payload.title as string,
        body: payload.body as string | undefined,
        icon: payload.icon as string | undefined,
      });
      return ok(result.message);
    },
  });

  // ── yaar://sessions/current/notifications/{id} — dismiss a specific notification ──
  registry.register('yaar://sessions/current/notifications/*', {
    description: 'A specific notification. Delete to dismiss.',
    verbs: ['describe', 'delete'],

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'session');
      if (!resolved.id) return error('Notification ID required.');
      dismissNotification(resolved.id);
      return ok(`Dismissed notification "${resolved.id}"`);
    },
  });

  // ── yaar://sessions/current/prompts — ask/request user interaction ──
  registry.register('yaar://sessions/current/prompts', {
    description:
      'User prompts. Invoke with action "ask" for multiple-choice questions, or "request" for freeform text input.',
    verbs: ['describe', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action', 'title', 'message'],
      properties: {
        action: { type: 'string', enum: ['ask', 'request'] },
        title: { type: 'string' },
        message: { type: 'string' },
        // ask fields
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        multiSelect: { type: 'boolean' },
        allowText: { type: 'boolean' },
        // request fields
        inputLabel: { type: 'string' },
        inputPlaceholder: { type: 'string' },
        multiline: { type: 'boolean' },
      },
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;
      if (!payload!.title || !payload!.message) return error('"title" and "message" are required.');

      const p = payload!;
      const action = p.action as string;

      if (action === 'ask') {
        const result = await askUser({
          title: p.title as string,
          message: p.message as string,
          options: p.options as Array<{ value: string; label: string; description?: string }>,
          multiSelect: p.multiSelect as boolean | undefined,
          allowText: p.allowText as boolean | undefined,
        });
        return result.success ? ok(result.result!) : error(result.error!);
      }

      if (action === 'request') {
        const result = await requestUserInput({
          title: p.title as string,
          message: p.message as string,
          inputLabel: p.inputLabel as string | undefined,
          inputPlaceholder: p.inputPlaceholder as string | undefined,
          multiline: p.multiline as boolean | undefined,
        });
        return result.success ? ok(result.text!) : error(result.error!);
      }

      return error(`Unknown action "${action}". Use "ask" or "request".`);
    },
  });
}
