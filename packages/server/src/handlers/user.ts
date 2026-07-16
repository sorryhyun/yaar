/**
 * User domain handlers for the verb layer.
 *
 * Maps user-facing operations to the verb layer. Unlike yaar://session/*
 * (session-principal only), these are open to every agent — any agent can
 * notify or ask the user.
 *
 *   invoke('yaar://user/notifications', { title, body, ... })  → show notification
 *   delete('yaar://user/notifications/{id}')                   → dismiss notification
 *   invoke('yaar://user/prompts', { action: 'ask', ... })      → ask user a question
 *   invoke('yaar://user/prompts', { action: 'request', ... })  → request user action
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error, assertUri, requireAction } from './utils.js';
import { defineActions } from './define-actions.js';
import { showNotification, dismissNotification } from '../features/user/notifications.js';
import { askUser, requestUserInput } from '../features/user/prompts.js';

export function registerUserHandlers(registry: ResourceRegistry): void {
  // ── yaar://user/notifications — show/manage notifications ──
  registry.register('yaar://user/notifications', {
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

  // ── yaar://user/notifications/{id} — dismiss a specific notification ──
  registry.register('yaar://user/notifications/*', {
    description: 'A specific notification. Delete to dismiss.',
    verbs: ['describe', 'delete'],

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'user');
      if (!resolved.id) return error('Notification ID required.');
      dismissNotification(resolved.id);
      return ok(`Dismissed notification "${resolved.id}"`);
    },
  });

  // ── yaar://user/prompts — ask/request user interaction ──
  const promptActions = defineActions<Record<string, unknown>>({
    ask: async (p) => {
      const result = await askUser({
        title: p.title as string,
        message: p.message as string,
        options: p.options as Array<{ value: string; label: string; description?: string }>,
        multiSelect: p.multiSelect as boolean | undefined,
        allowText: p.allowText as boolean | undefined,
      });
      return result.success ? ok(result.result!) : error(result.error!);
    },
    request: async (p) => {
      const result = await requestUserInput({
        title: p.title as string,
        message: p.message as string,
        inputLabel: p.inputLabel as string | undefined,
        inputPlaceholder: p.inputPlaceholder as string | undefined,
        multiline: p.multiline as boolean | undefined,
      });
      return result.success ? ok(result.text!) : error(result.error!);
    },
  });

  registry.register('yaar://user/prompts', {
    description:
      'User prompts. Invoke with action "ask" for multiple-choice questions, or "request" for freeform text input.',
    verbs: ['describe', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action', 'title', 'message'],
      properties: {
        action: promptActions.schema,
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
      return promptActions.dispatch(p.action as string, p);
    },
  });
}
