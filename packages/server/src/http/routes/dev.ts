/**
 * Dev routes — compile, typecheck, deploy for iframe apps.
 *
 * POST /api/dev/compile    — compile a project directory
 * POST /api/dev/typecheck  — typecheck a project directory
 * POST /api/dev/deploy     — deploy a project as an installed app
 *
 * All routes require iframe token auth (X-Iframe-Token header).
 * Paths are resolved relative to the app's storage directory.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { MAX_UPLOAD_SIZE, PROJECT_ROOT } from '../../config.js';
import { errorResponse, jsonResponse } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { validateIframeToken } from '../iframe-tokens.js';
import type { EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  { method: 'POST', path: '/api/dev/compile', response: 'json', description: 'Compile a project' },
  {
    method: 'POST',
    path: '/api/dev/typecheck',
    response: 'json',
    description: 'Typecheck a project',
  },
  { method: 'POST', path: '/api/dev/deploy', response: 'json', description: 'Deploy a project' },
];

/** Resolve and validate a path relative to app storage. Returns absolute path or null. */
function resolveAppPath(appId: string, path: string): string | null {
  if (!path || path.includes('..') || path.startsWith('/')) return null;
  return join(PROJECT_ROOT, 'storage', 'apps', appId, path);
}

export async function handleDevRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/dev/') || req.method !== 'POST') return null;

  const action = url.pathname.slice('/api/dev/'.length);
  if (action !== 'compile' && action !== 'typecheck' && action !== 'deploy') return null;

  // Auth
  const token = req.headers.get('X-Iframe-Token');
  const tokenEntry = token ? validateIframeToken(token) : null;
  if (!tokenEntry?.appId) {
    return errorResponse('Invalid or missing iframe token', 403);
  }

  // Body
  let body: Record<string, unknown>;
  try {
    const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return errorResponse('Request body too large', 413);
    return errorResponse('Invalid JSON body', 400);
  }

  const path = body.path as string;
  if (!path) return errorResponse('"path" is required', 400);

  const absolutePath = resolveAppPath(tokenEntry.appId, path);
  if (!absolutePath) return errorResponse('Invalid path', 400);

  try {
    await stat(absolutePath);
  } catch {
    return errorResponse(`Path "${path}" not found`, 404);
  }

  switch (action) {
    case 'compile': {
      const { compileTypeScript } = await import('../../lib/compiler/index.js');
      const result = await compileTypeScript(absolutePath, {
        title: (body.title as string) ?? 'App',
      });
      if (!result.success) {
        return jsonResponse({
          success: false,
          errors: result.errors ?? ['Unknown error'],
        });
      }
      return jsonResponse({
        success: true,
        previewUrl: `/api/storage/apps/${tokenEntry.appId}/${path}/dist/index.html`,
      });
    }

    case 'typecheck': {
      const { typecheckSandbox } = await import('../../lib/compiler/index.js');
      const result = await typecheckSandbox(absolutePath);
      return jsonResponse({
        success: result.success,
        diagnostics: result.diagnostics,
      });
    }

    case 'deploy': {
      const deployAppId = body.appId as string;
      if (!deployAppId) return errorResponse('"appId" is required for deploy', 400);

      const { doDeploy } = await import('../../features/dev/deploy.js');
      const result = await doDeploy(deployAppId, {
        sourcePath: absolutePath,
        appId: deployAppId,
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        icon: body.icon as string | undefined,
        permissions: body.permissions as string[] | undefined,
      });
      if (!result.success) return jsonResponse(result);
      return jsonResponse({
        success: true,
        appId: result.appId,
        name: result.name,
        icon: result.icon,
      });
    }
  }
}
