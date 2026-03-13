/**
 * Config domain handlers for the verb layer.
 *
 * Wraps existing config tool logic (settings, hooks, shortcuts, mounts, app)
 * as ResourceHandler registrations on the registry.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { handleSetSettings, handleGetSettings } from '../features/config/settings.js';
import {
  handleSetHook,
  handleGetHooks,
  handleRemoveHook,
} from '../features/config/hooks-handler.js';
import {
  handleSetShortcut,
  handleGetShortcuts,
  handleRemoveShortcut,
} from '../features/config/shortcuts.js';
import { handleSetMount, handleGetMounts, handleRemoveMount } from '../features/config/mounts.js';
import { handleSetApp, handleGetApp, handleRemoveApp } from '../features/config/app.js';
import {
  readAllowedDomains,
  isAllDomainsAllowed,
  isDomainAllowed,
  addAllowedDomain,
  setAllowAllDomains,
} from '../features/config/domains.js';
import { ok, okJson, error, assertUri } from './utils.js';
import { actionEmitter } from '../session/action-emitter.js';

export function registerConfigHandlers(registry: ResourceRegistry): void {
  // ── yaar://config/ — list all config sections ──
  registry.register('yaar://config/', {
    description: 'Configuration root — lists available config sections.',
    verbs: ['describe', 'list', 'read'],

    async list() {
      const sections = ['settings', 'hooks', 'shortcuts', 'mounts', 'app', 'domains'];
      return okJson({ sections: sections.map((s) => `yaar://config/${s}`) });
    },

    async read() {
      const [hooks, settings, shortcuts, mounts] = await Promise.all([
        handleGetHooks(),
        handleGetSettings(),
        handleGetShortcuts(),
        handleGetMounts(),
      ]);
      return okJson({ ...hooks, ...settings, ...shortcuts, ...mounts });
    },
  });

  // ── yaar://config/domains — domain allowlist ──
  registry.register('yaar://config/domains', {
    description:
      'HTTP domain allowlist. Read to see allowed domains. Invoke to request user permission for a new domain.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain to request access for (e.g., "api.example.com")',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for why this domain access is needed',
        },
        allowAll: {
          type: 'boolean',
          description: 'Toggle the "allow all domains" flag directly',
        },
      },
    },

    async read(): Promise<VerbResult> {
      const [domains, allowAll] = await Promise.all([readAllowedDomains(), isAllDomainsAllowed()]);
      return okJson({ allow_all_domains: allowAll, allowed_domains: domains });
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      // Handle allowAll toggle directly (no permission dialog needed)
      if (payload?.allowAll !== undefined) {
        const value = Boolean(payload.allowAll);
        const success = await setAllowAllDomains(value);
        if (success) {
          return ok(`"allow all domains" has been ${value ? 'enabled' : 'disabled'}.`);
        }
        return error('Failed to update "allow all domains" setting.');
      }

      const domain = payload?.domain as string | undefined;
      if (!domain) return error('"domain" or "allowAll" is required.');

      if (await isDomainAllowed(domain)) {
        return ok(`Domain "${domain}" is already in the allowed list.`);
      }

      const reasonText = payload?.reason ? `\n\nReason: ${payload.reason}` : '';
      const confirmed = await actionEmitter.showPermissionDialog(
        'Allow Domain Access',
        `The AI wants to make HTTP requests to "${domain}".${reasonText}\n\nDo you want to allow this domain?`,
        'http_domain',
        domain,
        'Allow',
        'Deny',
      );

      if (confirmed) {
        const success = await addAllowedDomain(domain);
        if (success) {
          return ok(`Domain "${domain}" has been added to the allowed list.`);
        }
        return error(`Failed to add domain "${domain}" to the allowed list.`);
      }
      return error(`User denied access to domain "${domain}".`);
    },
  });

  // ── yaar://config/settings ──
  registry.register('yaar://config/settings', {
    description:
      'User preferences — name, language, provider, appearance (wallpaper, accentColor, iconSize).',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string', description: 'Display name' },
        language: { type: 'string', description: 'Language code (e.g. en, ko, ja)' },
        onboardingCompleted: { type: 'boolean' },
        provider: {
          type: 'string',
          enum: ['auto', 'claude', 'codex'],
          description: 'AI provider (changes require page reload)',
        },
        wallpaper: {
          type: 'string',
          description:
            'Wallpaper preset key (dark-blue, midnight, aurora, ember, ocean, moss) or CSS color',
        },
        accentColor: {
          type: 'string',
          description: 'Accent color key (blue, lavender, mauve, pink, peach, yellow, green, red)',
        },
        iconSize: {
          type: 'string',
          enum: ['small', 'medium', 'large'],
          description: 'Desktop icon size',
        },
      },
    },

    async read(): Promise<VerbResult> {
      const data = await handleGetSettings();
      return okJson(data);
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
      return okJson(data);
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
      assertUri(resolved, 'config');
      // Return all hooks — the caller can filter by id
      const data = await handleGetHooks();
      const hookId = resolved.id;
      const hooks = data.hooks as Array<{ id: string }>;
      const hook = hookId ? hooks.find((h) => h.id === hookId) : null;
      if (!hook)
        return { content: [{ type: 'text', text: `Hook "${hookId}" not found.` }], isError: true };
      return okJson(hook);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'config');
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
      return okJson(data);
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
      assertUri(resolved, 'config');
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
      return okJson(data);
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
      assertUri(resolved, 'config');
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
      return okJson(data);
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
      assertUri(resolved, 'config');
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      const data = await handleGetApp(resolved.id);
      return okJson(data);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      assertUri(resolved, 'config');
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      // Wrap payload so handleSetApp sees { appId, config }
      const content = { appId: resolved.id, config: payload ?? {} };
      return handleSetApp(content);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'config');
      if (!resolved.id)
        return { content: [{ type: 'text', text: 'App ID required.' }], isError: true };
      return handleRemoveApp(resolved.id);
    },
  });
}
