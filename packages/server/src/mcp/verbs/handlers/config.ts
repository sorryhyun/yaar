/**
 * Config domain handlers for the verb layer.
 *
 * Wraps existing config tool logic (settings, hooks, shortcuts, mounts, app)
 * as ResourceHandler registrations on the registry.
 */

import type { ResourceRegistry, VerbResult } from '../../../uri/registry.js';
import type { ResolvedUri } from '../../../uri/resolve.js';
import { handleSetSettings, handleGetSettings } from '../../domains/config/settings.js';
import {
  handleSetHook,
  handleGetHooks,
  handleRemoveHook,
} from '../../domains/config/hooks-handler.js';
import {
  handleSetShortcut,
  handleGetShortcuts,
  handleRemoveShortcut,
} from '../../domains/config/shortcuts.js';
import { handleSetMount, handleGetMounts, handleRemoveMount } from '../../domains/config/mounts.js';
import { handleSetApp, handleGetApp, handleRemoveApp } from '../../domains/config/app.js';
import { ok } from '../../utils.js';

function assertConfig(
  resolved: ResolvedUri,
): asserts resolved is Extract<ResolvedUri, { kind: 'config' }> {
  if (resolved.kind !== 'config') throw new Error(`Expected config URI, got ${resolved.kind}`);
}

export function registerConfigHandlers(registry: ResourceRegistry): void {
  // ── yaar://config/ — list all config sections ──
  registry.register('yaar://config/', {
    description: 'Configuration root — lists available config sections.',
    verbs: ['describe', 'list', 'read'],

    async list() {
      const sections = ['settings', 'hooks', 'shortcuts', 'mounts', 'app'];
      return ok(JSON.stringify({ sections: sections.map((s) => `yaar://config/${s}`) }, null, 2));
    },

    async read() {
      const [hooks, settings, shortcuts, mounts] = await Promise.all([
        handleGetHooks(),
        handleGetSettings(),
        handleGetShortcuts(),
        handleGetMounts(),
      ]);
      return ok(JSON.stringify({ ...hooks, ...settings, ...shortcuts, ...mounts }, null, 2));
    },
  });

  // ── yaar://config/settings ──
  registry.register('yaar://config/settings', {
    description: 'User preferences (language, onboarding, etc.).',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Language code' },
        onboardingCompleted: { type: 'boolean' },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetSettings();
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload)
        return {
          content: [{ type: 'text', text: 'Payload required for settings update.' }],
          isError: true,
        };
      return handleSetSettings(payload);
    },
  });

  // ── yaar://config/hooks and yaar://config/hooks/{id} ──
  registry.register('yaar://config/hooks', {
    description: 'Event-driven hooks. Read to list all, invoke to create a new hook.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['event', 'label', 'action'],
      properties: {
        event: { type: 'string', enum: ['launch', 'tool_use'] },
        label: { type: 'string' },
        filter: { type: 'object' },
        action: { type: 'object' },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetHooks();
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload)
        return {
          content: [{ type: 'text', text: 'Payload required to create a hook.' }],
          isError: true,
        };
      return handleSetHook(payload);
    },
  });

  registry.register('yaar://config/hooks/*', {
    description: 'A specific hook. Read to view, delete to remove.',
    verbs: ['describe', 'read', 'delete'],

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      // Return all hooks — the caller can filter by id
      const data = await handleGetHooks();
      const hookId = resolved.id;
      const hooks = data.hooks as Array<{ id: string }>;
      const hook = hookId ? hooks.find((h) => h.id === hookId) : null;
      if (!hook)
        return { content: [{ type: 'text', text: `Hook "${hookId}" not found.` }], isError: true };
      return ok(JSON.stringify(hook, null, 2));
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'Hook ID required.' }], isError: true };
      return handleRemoveHook(resolved.id);
    },
  });

  // ── yaar://config/shortcuts and yaar://config/shortcuts/{id} ──
  registry.register('yaar://config/shortcuts', {
    description: 'Desktop shortcuts. Read to list all, invoke to create/update.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing shortcut ID to update (omit to create)' },
        label: { type: 'string' },
        icon: { type: 'string' },
        target: { type: 'string' },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetShortcuts();
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload)
        return { content: [{ type: 'text', text: 'Payload required.' }], isError: true };
      return handleSetShortcut(payload);
    },
  });

  registry.register('yaar://config/shortcuts/*', {
    description: 'A specific shortcut. Delete to remove.',
    verbs: ['describe', 'delete'],

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'Shortcut ID required.' }], isError: true };
      return handleRemoveShortcut(resolved.id);
    },
  });

  // ── yaar://config/mounts and yaar://config/mounts/{alias} ──
  registry.register('yaar://config/mounts', {
    description: 'Host directory mounts. Read to list, invoke to add a mount.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['alias', 'hostPath'],
      properties: {
        alias: { type: 'string' },
        hostPath: { type: 'string' },
        readOnly: { type: 'boolean' },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetMounts();
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload)
        return { content: [{ type: 'text', text: 'Payload required.' }], isError: true };
      return handleSetMount(payload);
    },
  });

  registry.register('yaar://config/mounts/*', {
    description: 'A specific mount. Delete to unmount.',
    verbs: ['describe', 'delete'],

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'Mount alias required.' }], isError: true };
      return handleRemoveMount(resolved.id);
    },
  });

  // ── yaar://config/app and yaar://config/app/{appId} ──
  registry.register('yaar://config/app', {
    description: 'Per-app configuration. Read to list all app configs, invoke to set.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['appId', 'config'],
      properties: {
        appId: { type: 'string' },
        config: { type: 'object', description: 'Key-value config to merge' },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetApp();
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload)
        return { content: [{ type: 'text', text: 'Payload required.' }], isError: true };
      return handleSetApp(payload);
    },
  });

  registry.register('yaar://config/app/*', {
    description: "A specific app's config. Read to view, invoke to update, delete to remove.",
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'Key-value config to merge' },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      const data = await handleGetApp(resolved.id);
      return ok(JSON.stringify(data, null, 2));
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      // Wrap payload so handleSetApp sees { appId, config }
      const content = { appId: resolved.id, config: payload ?? {} };
      return handleSetApp(content);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertConfig(resolved);
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      return handleRemoveApp(resolved.id);
    },
  });
}
