/**
 * Dev routes — compile, typecheck, deploy, and version history for iframe apps.
 *
 * GET  /api/dev/preview/{appId} — serve an installed app as a TOP-LEVEL page, with
 *                                 an iframe token injected (host-only, see below)
 * POST /api/dev/compile       — compile a project directory
 * POST /api/dev/typecheck     — typecheck a project directory
 * POST /api/dev/deploy        — deploy a project as an installed app
 * POST /api/dev/format        — format one file's text (text in, text out; no disk)
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
import { requireBundledApp, requireHost, resolvePrincipal, type AppPrincipal } from '../access.js';
import { generateAppIframeToken } from '../iframe-tokens.js';
import { appHtmlCsp } from '../csp.js';
import { runWithAgentContext } from '../../agents/agent-context.js';
import { resolveAppDir, resolveAppSource } from '../../features/apps/roots.js';
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
    path: '/api/dev/format',
    response: 'json',
    description: "Format a file's source text",
  },
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

/** App ids are directory names. Keep this to what a directory name may be. */
const APP_ID = /^[A-Za-z0-9._-]+$/;

const PATH_ACTIONS = ['compile', 'typecheck', 'deploy'] as const;
const GIT_ACTIONS = ['git-history', 'git-diff', 'git-restore', 'git-checkpoint'] as const;
/** Actions over text the caller sends, addressing no project directory at all. */
const TEXT_ACTIONS = ['format'] as const;

type PathAction = (typeof PATH_ACTIONS)[number];
type GitAction = (typeof GIT_ACTIONS)[number];
type TextAction = (typeof TEXT_ACTIONS)[number];
type DevAction = PathAction | GitAction | TextAction;

function isDevAction(action: string): action is DevAction {
  return (
    (PATH_ACTIONS as readonly string[]).includes(action) ||
    (GIT_ACTIONS as readonly string[]).includes(action) ||
    (TEXT_ACTIONS as readonly string[]).includes(action)
  );
}

function isTextAction(action: DevAction): action is TextAction {
  return (TEXT_ACTIONS as readonly string[]).includes(action);
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

  if (url.pathname.startsWith('/api/dev/preview/') && req.method === 'GET') {
    return servePreview(req, url);
  }

  // GET /api/dev/bundled-libraries — no auth required (static list)
  // GET /api/dev/bundled-libraries?lib=yaar — returns detailed type info for a specific library
  // GET /api/dev/bundled-libraries?lib=design-tokens — returns the generated token reference
  //
  // `design-tokens` deliberately has no branch of its own. It used to return the raw
  // injected CSS — ~10KB of rules an agent cannot act on, most of it a verbatim repeat
  // of the Design Tokens section already in its prompt — while `getBundledLibraryDetail`
  // had a pseudo-library entry producing exactly the summary that was wanted (names and
  // classes, generated from the same CSS). The branch shadowed it.
  if (url.pathname === '/api/dev/bundled-libraries' && req.method === 'GET') {
    const lib = url.searchParams.get('lib');
    if (lib) {
      const { getBundledLibraryDetail } = await import('@yaar/compiler');
      const detail = getBundledLibraryDetail(lib);
      if (!detail) return errorResponse(`Unknown bundled library: "${lib}"`, 404);
      return jsonResponse({ name: lib, types: detail });
    }
    // Describable, not merely importable: the caller's next move is to pass one of
    // these back as `?lib=`, so the list has to be the set that answers.
    const { getDescribableLibraries } = await import('@yaar/compiler');
    return jsonResponse(getDescribableLibraries());
  }

  if (req.method !== 'POST') return null;

  const action = url.pathname.slice('/api/dev/'.length);
  if (!isDevAction(action)) return null;

  // Auth. `yaar-dev` opens compile/typecheck/deploy and per-app git history — the
  // compiler already refuses to bundle that SDK unless app.json declares it, but the
  // compiler only sees the app's *source*. A hand-written fetch() never went near it,
  // so the door checks the declaration itself.
  const principal = requireBundledApp(req, url, 'yaar-dev');
  if (principal instanceof Response) return principal;
  // A plain (non-app) iframe window has no appId, and every action below addresses
  // an app. It cannot reach here anyway — an appId-less token carries no bundles —
  // but the actions need the narrowing.
  const callerAppId = principal.appId;
  if (!callerAppId) return errorResponse('Invalid or missing iframe token', 403);

  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body instanceof Response) return body;

  // Run the action as the calling iframe, the way POST /api/verb does.
  //
  // Deploy and git-restore emit desktop actions (`refreshApps`, shortcut add/remove) to
  // put the app's new state on screen, and an emitted action is addressed from the agent
  // context. Without one there is no addressee: the emit used to go out session-less and
  // reach every desktop, and now it is dropped with a line in the log. Either way the
  // caller's own desktop is the only one that asked, and the token names it.
  return runWithAgentContext(
    {
      agentId: `iframe:${callerAppId}`,
      sessionId: principal.sessionId,
      monitorId: principal.monitorId,
      windowId: principal.windowId,
      appId: callerAppId,
    },
    () => dispatchDevAction(action, body, principal, callerAppId),
  );
}

/**
 * Serve an installed app as a top-level page with its iframe token injected.
 *
 * Driving an app through the whole desktop is the wrong inner loop for verifying
 * one app: you fight window management, you cannot reach into a cross-origin
 * iframe from CDP, and the app's own automation hook is two frames down. Opening
 * `dist/index.html` directly is far better — but the app is then token-less, so
 * every gated SDK call (`appStorage`, `appDb`, `/api/ml-weights`) 403s, and the
 * failure ("Invalid or missing iframe token") points nowhere near the cause.
 *
 * This route closes that: it mints the app's real token — the same identity
 * `generateAppIframeToken` gives the app in a window, permissions and `bundles`
 * read off its own app.json, never from the request — and injects it ahead of the
 * SDK scripts, which read `window.__YAAR_TOKEN__` at install time.
 *
 * **Host-only.** It hands out an app's token, so it is the same
 * privilege-escalation oracle `POST /api/iframe-token` is, and carries the same
 * gate: reachable by an app, any app could mint a bundled system app's token. In
 * REMOTE mode the caller has already proven the remote token in auth.ts.
 *
 * On the host name: with app-origin isolation on, `127.0.0.1` is the *app* origin
 * and a token-less request carrying it is refused — so this must be opened on
 * `localhost`. A top-level navigation to `127.0.0.1` is already redirected there
 * (http/server.ts), which is what makes the mistake self-correcting rather than a
 * blank page with a 403 in the console.
 */
async function servePreview(req: Request, url: URL): Promise<Response> {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  const denied = requireHost(principal);
  if (denied) return denied;

  const appId = decodeURIComponent(url.pathname.slice('/api/dev/preview/'.length)).replace(
    /\/$/,
    '',
  );
  if (!appId || !APP_ID.test(appId)) return errorResponse('Invalid app id', 400);

  const appDir = resolveAppDir(appId);
  if (!appDir) return errorResponse(`App "${appId}" not found`, 404);

  const entry = Bun.file(join(appDir, 'dist', 'index.html'));
  if (!(await entry.exists())) {
    return errorResponse(`App "${appId}" has no dist/index.html — compile it first`, 404);
  }
  const html = await entry.text();

  // Bind the token to the running desktop's session when there is one, so
  // session-scoped verbs (windows, notifications) act on the desktop the developer
  // is looking at. With no desktop connected the app still gets its own storage,
  // db, and gated HTTP doors — those are keyed on the app, not the session.
  const { getSessionHub } = await import('../../session/session-hub.js');
  const sessionId = getSessionHub().getDefault()?.sessionId ?? `dev-preview-${appId}`;
  const token = await generateAppIframeToken(`preview:${appId}`, sessionId, { appId });

  // Ahead of the compiler's own <script>, which installs the SDKs and reads the
  // token as it does so. Anchoring on <head> rather than that script keeps this
  // independent of the wrapper's internal ordering.
  const inject = `<script>window.__YAAR_TOKEN__=${JSON.stringify(token)};</script>`;
  const headAt = html.indexOf('<head>');
  const body =
    headAt === -1 ? inject + html : html.slice(0, headAt + 6) + inject + html.slice(headAt + 6);

  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The same CSP the app runs under in a window, so a preview cannot pass
      // something the deployed app would be refused.
      'Content-Security-Policy': appHtmlCsp(req),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * The dev action itself, split out so the whole of it runs inside one agent context.
 */
async function dispatchDevAction(
  action: DevAction,
  body: Record<string, unknown>,
  principal: AppPrincipal,
  callerAppId: string,
): Promise<Response | null> {
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
            statOnly: body.statOnly === true,
            ...(Array.isArray(body.paths)
              ? { paths: body.paths.filter((p): p is string => typeof p === 'string') }
              : {}),
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

  // Formatting addresses text, not a project — it opens no file and writes none, so it
  // branches out ahead of the path resolution the compile/typecheck/deploy actions need.
  // The caller reads its own file and writes back the answer, which is what keeps its
  // change history and open editor buffer describing the bytes that are actually there.
  if (isTextAction(action)) {
    const source = body.source;
    const filePath = body.path;
    if (typeof source !== 'string') return errorResponse('"source" is required', 400);
    if (typeof filePath !== 'string' || !filePath) return errorResponse('"path" is required', 400);

    const { formatSource } = await import('../../features/dev/format.js');
    const result = await formatSource(source, filePath);
    if (!result.ok) {
      return jsonResponse({ success: false, kind: result.kind, error: result.reason });
    }
    return jsonResponse({ success: true, formatted: result.formatted, changed: result.changed });
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
  //
  // The second reader of this same key on this same file is `previewBundles`
  // (http/iframe-tokens.ts), which puts it on the preview's iframe token so the
  // *runtime* doors admit what the compiler bundled. The two must agree. They resolve
  // the file differently and cannot be merged as they stand: a compile names its own
  // source directory (`resolveAppPath(callerAppId, path)` — caller-relative, no app id
  // hardcoded), while a token mint has only `preview--{projectId}` and reconstructs
  // devtools' project layout. Anything that changes where a project's app.json lives
  // has to change both.
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
        // Manifest key names as extracted, so callers can inspect what the
        // agent will see without deploying. Null when the app registers none.
        protocol: result.protocol ?? null,
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
        allowProtocolShrink: body.allowProtocolShrink === true,
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
