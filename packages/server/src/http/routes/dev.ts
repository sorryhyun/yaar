/**
 * Dev routes — compile, typecheck, deploy, and version history for iframe apps.
 *
 * POST /api/dev/compile       — compile a project directory
 * POST /api/dev/typecheck     — typecheck a project directory
 * POST /api/dev/deploy        — deploy a project as an installed app
 * POST /api/dev/git-history   — list an app's version history
 * POST /api/dev/git-diff      — diff an app against a snapshot or the host repo
 * POST /api/dev/git-restore   — roll an app back to an earlier commit
 * POST /api/dev/git-checkpoint— snapshot an app's current state
 *
 * All routes require iframe token auth (X-Iframe-Token header).
 * Source paths are resolved relative to the calling app's storage directory.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { PROJECT_ROOT } from '../../config.js';
import { errorResponse, jsonResponse, parseJsonBody } from '../utils.js';
import { requireBundle, resolvePrincipal } from '../access.js';
import { resolveAppSource } from '../../features/apps/roots.js';
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
  {
    method: 'POST',
    path: '/api/dev/git-history',
    response: 'json',
    description: "List an app's version history",
  },
  {
    method: 'POST',
    path: '/api/dev/git-diff',
    response: 'json',
    description: 'Diff an app against a snapshot or the host repo',
  },
  {
    method: 'POST',
    path: '/api/dev/git-restore',
    response: 'json',
    description: 'Roll an app back to an earlier commit',
  },
  {
    method: 'POST',
    path: '/api/dev/git-checkpoint',
    response: 'json',
    description: "Snapshot an app's current state",
  },
  {
    method: 'GET',
    path: '/api/dev/bundled-libraries',
    response: 'json',
    description: 'List bundled libraries',
  },
];

const PATH_ACTIONS = ['compile', 'typecheck', 'deploy'] as const;
const GIT_ACTIONS = ['git-history', 'git-diff', 'git-restore', 'git-checkpoint'] as const;

type PathAction = (typeof PATH_ACTIONS)[number];
type GitAction = (typeof GIT_ACTIONS)[number];
type DevAction = PathAction | GitAction;

function isDevAction(action: string): action is DevAction {
  return (
    (PATH_ACTIONS as readonly string[]).includes(action) ||
    (GIT_ACTIONS as readonly string[]).includes(action)
  );
}

function isGitAction(action: DevAction): action is GitAction {
  return (GIT_ACTIONS as readonly string[]).includes(action);
}

/** Resolve and validate a path relative to app storage. Returns absolute path or null. */
function resolveAppPath(appId: string, path: string): string | null {
  if (!path || path.includes('..') || path.startsWith('/')) return null;
  return join(PROJECT_ROOT, 'storage', 'apps', appId, path);
}

/**
 * May `caller` mutate `target`'s app directory (deploy / restore / checkpoint)?
 *
 * An app may always write itself. Writing *another* app is restricted to bundled
 * apps — mirroring the existing bundled-only guard on `controls`
 * (`features/apps/discovery.ts:330`). Without this, any marketplace app that
 * declares `"bundles": ["yaar-dev"]` could overwrite `browser-user` or any other
 * system app with code of its choosing.
 */
function canWriteApp(callerAppId: string, targetAppId: string): boolean {
  if (callerAppId === targetAppId) return true;
  return resolveAppSource(callerAppId) === 'bundled';
}

function writeDenied(callerAppId: string, targetAppId: string): Response {
  return errorResponse(
    `App "${callerAppId}" may not modify "${targetAppId}". Only bundled apps can write app directories other than their own.`,
    403,
  );
}

export async function handleDevRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/dev/')) return null;

  // GET /api/dev/bundled-libraries — no auth required (static list)
  // GET /api/dev/bundled-libraries?lib=yaar — returns detailed type info for a specific library
  // GET /api/dev/bundled-libraries?lib=design-tokens — returns design tokens CSS
  if (url.pathname === '/api/dev/bundled-libraries' && req.method === 'GET') {
    const lib = url.searchParams.get('lib');
    if (lib) {
      if (lib === 'design-tokens') {
        const { YAAR_DESIGN_TOKENS_CSS } = await import('@yaar/compiler');
        return jsonResponse({ name: lib, types: YAAR_DESIGN_TOKENS_CSS });
      }
      const { getBundledLibraryDetail } = await import('@yaar/compiler');
      const detail = getBundledLibraryDetail(lib);
      if (!detail) return errorResponse(`Unknown bundled library: "${lib}"`, 404);
      return jsonResponse({ name: lib, types: detail });
    }
    const { getAvailableBundledLibraries } = await import('@yaar/compiler');
    return jsonResponse(getAvailableBundledLibraries());
  }

  if (req.method !== 'POST') return null;

  const action = url.pathname.slice('/api/dev/'.length);
  if (!isDevAction(action)) return null;

  // Auth. `yaar-dev` opens compile/typecheck/deploy and per-app git history — the
  // compiler already refuses to bundle that SDK unless app.json declares it, but the
  // compiler only sees the app's *source*. A hand-written fetch() never went near it,
  // so the door checks the declaration itself.
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  if (principal.kind !== 'app' || !principal.appId) {
    return errorResponse('Invalid or missing iframe token', 403);
  }
  const bundleDenied = requireBundle(principal, 'yaar-dev');
  if (bundleDenied) return bundleDenied;
  const callerAppId = principal.appId;

  // Body
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body instanceof Response) return body;

  // Git actions address an *app*, not a sandbox project path — they branch out
  // before the path resolution the compile/typecheck/deploy actions need.
  if (isGitAction(action)) {
    const targetAppId = (body.appId as string) || callerAppId;
    const git = await import('../../features/dev/git.js');

    switch (action) {
      case 'git-history': {
        const limit = typeof body.limit === 'number' ? body.limit : undefined;
        return jsonResponse(await git.appHistory(targetAppId, limit));
      }

      case 'git-diff': {
        const against = body.against === 'repo' ? 'repo' : 'snapshot';
        return jsonResponse(
          await git.appDiff(targetAppId, {
            ref: typeof body.ref === 'string' ? body.ref : undefined,
            against,
          }),
        );
      }

      case 'git-restore': {
        if (!canWriteApp(callerAppId, targetAppId)) return writeDenied(callerAppId, targetAppId);
        const ref = body.ref as string;
        if (!ref) return errorResponse('"ref" is required for git-restore', 400);
        return jsonResponse(await git.restoreApp(targetAppId, ref));
      }

      case 'git-checkpoint': {
        if (!canWriteApp(callerAppId, targetAppId)) return writeDenied(callerAppId, targetAppId);
        const message =
          typeof body.message === 'string' && body.message.trim()
            ? body.message.trim()
            : `checkpoint: ${targetAppId}`;
        await git.snapshotApp(targetAppId, message);
        return jsonResponse(await git.appHistory(targetAppId, 1));
      }
    }
  }

  const path = body.path as string;
  if (!path) return errorResponse('"path" is required', 400);

  const absolutePath = resolveAppPath(callerAppId, path);
  if (!absolutePath) return errorResponse('Invalid path', 400);

  try {
    await stat(absolutePath);
  } catch {
    return errorResponse(`Path "${path}" not found`, 404);
  }

  // Both typecheck and compile must enforce gated @bundled/yaar-* imports.
  let bundles: string[] | undefined;
  try {
    const appJson = JSON.parse(await Bun.file(join(absolutePath, 'app.json')).text());
    if (Array.isArray(appJson.bundles)) bundles = appJson.bundles;
  } catch {
    /* no app.json */
  }

  switch (action) {
    case 'compile': {
      const { compileTypeScript } = await import('@yaar/compiler');
      const result = await compileTypeScript(absolutePath, {
        title: (body.title as string) ?? 'App',
        bundles,
      });
      if (!result.success) {
        return jsonResponse({
          success: false,
          errors: result.errors ?? ['Unknown error'],
        });
      }
      return jsonResponse({
        success: true,
        previewUrl: `/api/storage/apps/${callerAppId}/${path}/dist/index.html`,
      });
    }

    case 'typecheck': {
      const { typecheckSandbox } = await import('@yaar/compiler');
      const result = await typecheckSandbox(absolutePath, { bundles });
      return jsonResponse({
        success: result.success,
        diagnostics: result.diagnostics,
      });
    }

    case 'deploy': {
      const deployAppId = body.appId as string;
      if (!deployAppId) return errorResponse('"appId" is required for deploy', 400);
      if (!canWriteApp(callerAppId, deployAppId)) return writeDenied(callerAppId, deployAppId);

      const { doDeploy } = await import('../../features/dev/deploy.js');
      const result = await doDeploy(deployAppId, {
        sourcePath: absolutePath,
        appId: deployAppId,
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        icon: body.icon as string | undefined,
        message: body.message as string | undefined,
        skipTypecheck: body.skipTypecheck === true,
        sessionId: principal.sessionId,
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
