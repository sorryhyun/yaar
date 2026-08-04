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
 *   read('yaar://user/clipboard')                              → what is on the clipboard
 *   invoke('yaar://user/clipboard', { action: 'write', ... })  → put text on the clipboard
 *   invoke('yaar://user/clipboard', { action: 'save', ... })   → the whole of it, to a file
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, okWithImages, error, assertUri, requireAction } from './utils.js';
import { defineActions } from './define-actions.js';
import { showNotification, dismissNotification } from '../features/user/notifications.js';
import { askUser, requestUserInput } from '../features/user/prompts.js';
import {
  readClipboard,
  writeClipboard,
  saveClipboard,
  CLIPBOARD_TEXT_LIMIT,
  CLIPBOARD_IMAGE_MAX_PX,
} from '../features/user/clipboard.js';
import { describeRedactions } from '../features/user/secret-scan.js';

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

    /**
     * The one wildcard namespace whose existence the server genuinely cannot answer.
     * A notification is an emitted action, not a stored resource: the client owns the
     * toast and auto-dismisses it on its own timer, and nothing here holds a roster to
     * check an id against. So `describe` says that outright rather than reporting a
     * confident yes (which an `exists` returning `true` would be) — dismissal is
     * idempotent, and the honest answer is "ask the desktop, not me".
     */
    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'user');
      return okJson({
        uri: resolved.sourceUri,
        description:
          'A notification the desktop is showing. Delete to dismiss it. The server keeps no ' +
          'notification roster — the client owns the toast and auto-dismisses it — so whether ' +
          'this id is still on screen cannot be answered here. Dismissing an id that is already ' +
          'gone is a no-op.',
        verbs: ['describe', 'delete'],
      });
    },

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

  // ── yaar://user/clipboard — the system clipboard, read through the desktop ──
  const clipboardActions = defineActions<Record<string, unknown>>({
    write: {
      description: 'Put text on the system clipboard.',
      run: async (p) => {
        if (typeof p.text !== 'string') return error('"text" (string) is required for "write".');
        const result = await writeClipboard(p.text);
        return result.success
          ? ok(`Copied ${p.text.length} characters to the clipboard.`)
          : error(result.error!);
      },
    },
    save: {
      description:
        'Write the whole clipboard (untruncated text, full-resolution image) to a storage ' +
        'path and return its URI. The door for content too large to read.',
      run: async (p) => {
        if (typeof p.path !== 'string' || !p.path.trim()) {
          return error('"path" (a storage path like "temp/paste.txt") is required for "save".');
        }
        const result = await saveClipboard(p.path.trim());
        if (!result.success) return error(result.error!);
        return okJson({
          uri: result.uri,
          kind: result.kind,
          bytes: result.bytes,
          ...(result.redactions ? { redacted: describeRedactions(result.redactions) } : {}),
          ...(result.truncated
            ? {
                truncated: true,
                totalChars: result.totalChars,
                note: 'The clipboard exceeded even the save ceiling; the file holds its start.',
              }
            : {}),
        });
      },
    },
  });

  registry.register('yaar://user/clipboard', {
    description:
      'The system clipboard. Read it to see what the user has copied — text is truncated ' +
      `to ${CLIPBOARD_TEXT_LIMIT.toLocaleString()} characters and an image is downscaled to ` +
      `${CLIPBOARD_IMAGE_MAX_PX}px on its longest edge, both reported when they happen. ` +
      'Invoke with action "write" to put text on it, or action "save" to write the whole ' +
      'of it (untruncated text, full-resolution image) to storage and get back a URI.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: clipboardActions.schema,
        text: { type: 'string', description: 'Text to put on the clipboard (write)' },
        path: {
          type: 'string',
          description:
            'Storage path to write the clipboard to, e.g. "temp/paste.txt" (save). For an ' +
            "image the extension may be omitted — the clipboard's own format decides it.",
        },
      },
    },

    /**
     * Written out rather than auto-generated, because the two things most likely to go
     * wrong here are not visible from the schema: the clipboard lives in the *browser*
     * (so a read can be refused by a permission YAAR does not own, and there is a real
     * user-consent story behind it), and a read is deliberately lossy.
     */
    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'user');
      return okJson({
        uri: resolved.sourceUri,
        description:
          'The user’s system clipboard. YAAR has no clipboard of its own: the read happens ' +
          'in the browser showing the desktop, which under REMOTE=1 may be a different ' +
          'machine entirely than the one running the server. The browser gates clipboard ' +
          'reads behind its own permission prompt, so the first read may need the user to ' +
          'allow it, and a refusal is theirs rather than an error to retry around.',
        verbs: ['describe', 'read', 'invoke'],
        secrets:
          'Vendor-prefixed credentials (API keys, access tokens, private keys, passwords in ' +
          'connection URLs) are replaced with placeholders before clipboard text reaches you ' +
          'or is written by "save". A read that removed something says so. Detection is ' +
          'prefix-anchored, so it is not a guarantee — clipboard content is still the user’s ' +
          'private data and treating it as publishable because it came back clean is wrong.',
        limits: {
          textChars: CLIPBOARD_TEXT_LIMIT,
          imageLongestEdgePx: CLIPBOARD_IMAGE_MAX_PX,
          note:
            'A read is sized for a conversation and says so when it trims. When the whole ' +
            'thing is wanted, invoke with action "save" — it writes to storage and returns ' +
            'a URI instead of spending context on bytes nobody reads.',
        },
        invokeActions: clipboardActions.docs,
      });
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'user');
      const result = await readClipboard();
      if (!result.success) return error(result.error!);

      const notes: string[] = [];
      // First, so it is read before the content it describes rather than as a footnote to
      // text the agent has already started acting on.
      if (result.redactions) notes.push(describeRedactions(result.redactions));
      if (result.text !== undefined) {
        notes.push(
          result.truncated
            ? `Clipboard text (first ${result.text.length.toLocaleString()} of ` +
                `${result.totalChars?.toLocaleString()} characters — invoke with action "save" ` +
                `to write all of it to storage):\n\n${result.text}`
            : `Clipboard text:\n\n${result.text}`,
        );
      }
      if (result.image) {
        const { width, height, bytes, downscaled, mimeType } = result.image;
        notes.push(
          `Clipboard image: ${width}×${height} originally, attached as ${mimeType} ` +
            `(${Math.round(bytes / 1024)} KB)` +
            (downscaled
              ? ' — downscaled for viewing; action "save" writes it at full resolution.'
              : '.'),
        );
      }

      const text = notes.join('\n\n');
      return result.image
        ? okWithImages(text, [{ data: result.image.data, mimeType: result.image.mimeType }])
        : ok(text);
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;
      return clipboardActions.dispatch(payload!.action as string, payload!);
    },
  });
}
