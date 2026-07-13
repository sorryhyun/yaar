/**
 * Shortcut routes — CRUD for desktop shortcuts.
 *
 * GET    /api/shortcuts      — list all desktop shortcuts
 * POST   /api/shortcuts      — create a desktop shortcut
 * PATCH  /api/shortcuts/:id  — update a desktop shortcut
 * DELETE /api/shortcuts/:id  — delete a desktop shortcut
 */

import {
  readShortcuts,
  addShortcut,
  removeShortcut,
  updateShortcut,
} from '../../storage/shortcuts.js';
import type { DesktopShortcut } from '@yaar/shared';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';
import { requirePermission, resolvePrincipal } from '../access.js';
import type { Verb } from '../../handlers/uri-registry.js';

/**
 * Empty on purpose. A shortcut carries `osActions` — it is stored, user-clickable
 * code. Writing one is not a data write, it is planting an action on the desktop.
 * An app that needs it declares `yaar://config/shortcuts` in app.json.
 */
export const PUBLIC_ENDPOINTS: EndpointMeta[] = [];

/** The verb each shortcut method performs. */
function shortcutVerb(method: string): Verb | null {
  switch (method) {
    case 'GET':
      return 'read';
    case 'POST':
    case 'PATCH':
      return 'invoke';
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
}

export async function handleShortcutRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/shortcuts')) return null;

  const idMatch = url.pathname.match(/^\/api\/shortcuts\/([^/]+)$/);
  const verb = shortcutVerb(req.method);
  if (!verb) return null;

  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;

  const denied = requirePermission(
    principal,
    idMatch
      ? `yaar://config/shortcuts/${decodeURIComponent(idMatch[1])}`
      : 'yaar://config/shortcuts',
    verb,
  );
  if (denied) return denied;

  // List desktop shortcuts
  if (url.pathname === '/api/shortcuts' && req.method === 'GET') {
    try {
      const shortcuts = await readShortcuts();
      return jsonResponse({ shortcuts });
    } catch {
      return errorResponse('Failed to list shortcuts');
    }
  }

  // Create shortcut
  if (url.pathname === '/api/shortcuts' && req.method === 'POST') {
    try {
      const body = await req.text();
      if (!body.trim()) return errorResponse('Empty body', 400);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        return errorResponse('Invalid JSON', 400);
      }
      if (!data.label || !data.icon || (!data.target && !data.skill)) {
        return errorResponse('Shortcuts require label, icon, and target (or skill) fields', 400);
      }
      const shortcut: DesktopShortcut = {
        id:
          (data.id as string) || `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: data.label as string,
        icon: data.icon as string,
        iconType: data.iconType as 'emoji' | 'image' | undefined,
        target: (data.target as string) || '',
        osActions: data.osActions as DesktopShortcut['osActions'],
        skill: data.skill as string | undefined,
        ...(data.folderId ? { folderId: data.folderId as string } : {}),
        createdAt: Date.now(),
      };
      await addShortcut(shortcut);
      return jsonResponse({ shortcut }, 201);
    } catch {
      return errorResponse('Failed to create shortcut');
    }
  }

  // Update or delete shortcut by ID — parse the path once
  const shortcutIdMatch = url.pathname.match(/^\/api\/shortcuts\/([^/]+)$/);
  if (shortcutIdMatch) {
    const shortcutId = decodeURIComponent(shortcutIdMatch[1]);

    if (req.method === 'PATCH') {
      try {
        const body = await req.text();
        if (!body.trim()) return errorResponse('Empty body', 400);
        let updates: Record<string, unknown>;
        try {
          updates = JSON.parse(body);
        } catch {
          return errorResponse('Invalid JSON', 400);
        }
        const updated = await updateShortcut(shortcutId, updates);
        if (!updated) return errorResponse('Shortcut not found', 404);
        return jsonResponse({ shortcut: updated });
      } catch {
        return errorResponse('Failed to update shortcut');
      }
    }

    if (req.method === 'DELETE') {
      try {
        const removed = await removeShortcut(shortcutId);
        if (!removed) return errorResponse('Shortcut not found', 404);
        return jsonResponse({ ok: true });
      } catch {
        return errorResponse('Failed to delete shortcut');
      }
    }
  }

  return null;
}
