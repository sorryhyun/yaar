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

import type { OSAction } from '@yaar/shared';
import type { ResourceRegistry, VerbResult } from './uri/registry.js';
import type { ResolvedUri, ResolvedSession } from './uri/resolve.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import { ok, error } from '../mcp/utils.js';

function assertSessionUser(resolved: ResolvedUri): asserts resolved is ResolvedSession {
  if (resolved.kind !== 'session') throw new Error(`Expected session URI, got ${resolved.kind}`);
}

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
      const id = (payload.id as string) || `notif-${Date.now().toString(36)}`;
      const osAction: OSAction = {
        type: 'notification.show',
        id,
        title: payload.title as string,
        body: (payload.body as string) ?? '',
        icon: payload.icon as string | undefined,
      };
      actionEmitter.emitAction(osAction);
      return ok(`Notification "${payload.title}" shown`);
    },
  });

  // ── yaar://sessions/current/notifications/{id} — dismiss a specific notification ──
  registry.register('yaar://sessions/current/notifications/*', {
    description: 'A specific notification. Delete to dismiss.',
    verbs: ['describe', 'delete'],

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertSessionUser(resolved);
      if (!resolved.id) return error('Notification ID required.');
      const osAction: OSAction = {
        type: 'notification.dismiss',
        id: resolved.id,
      };
      actionEmitter.emitAction(osAction);
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
      if (!payload?.action) return error('Payload must include "action" ("ask" or "request").');
      if (!payload.title || !payload.message) return error('"title" and "message" are required.');

      const action = payload.action as string;

      if (action === 'ask') {
        if (!payload.options || !Array.isArray(payload.options) || payload.options.length < 2) {
          return error('"options" (array of at least 2) is required for "ask".');
        }
        const result = await actionEmitter.showUserPrompt({
          title: payload.title as string,
          message: payload.message as string,
          options: payload.options as Array<{ value: string; label: string; description?: string }>,
          multiSelect: payload.multiSelect as boolean | undefined,
          inputField: payload.allowText ? { placeholder: 'Type your answer…' } : undefined,
          allowDismiss: true,
        });

        if (result.dismissed) return error('User dismissed the prompt without answering.');

        const parts: string[] = [];
        if (result.selectedValues?.length)
          parts.push(`Selected: ${result.selectedValues.join(', ')}`);
        if (result.text) parts.push(`Text: ${result.text}`);
        return ok(parts.join('\n') || 'No selection made.');
      }

      if (action === 'request') {
        const result = await actionEmitter.showUserPrompt({
          title: payload.title as string,
          message: payload.message as string,
          inputField: {
            label: payload.inputLabel as string | undefined,
            placeholder: payload.inputPlaceholder as string | undefined,
            type: payload.multiline ? 'textarea' : 'text',
          },
          allowDismiss: true,
        });

        if (result.dismissed) return error('User dismissed the request without responding.');
        if (!result.text) return error('User submitted an empty response.');
        return ok(result.text);
      }

      return error(`Unknown action "${action}". Use "ask" or "request".`);
    },
  });
}
