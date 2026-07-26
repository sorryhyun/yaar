export {};
import { appStorage, errMsg, invoke, read, AppCommandError } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { ProjectAppJsonSchema, type PermissionEntry } from '../schema';
import { activeProject, previewUrl, previewWindowId, setPreviewWindowId } from '../core';
import { addConsoleEntry } from './console';

// Preview window mechanics: how it is opened and how pixels are read back out.
//
// Only the helpers live here, not the preview *commands*. The app protocol
// manifest is produced by statically reading the `commands` object literal in
// protocol.ts, so a command reached via a spread (`...previewCommands`) compiles
// and runs fine but vanishes from the manifest — leaving agents unable to see it.
// Command definitions therefore stay inline in protocol.ts; the bodies they call
// are what gets factored out.

export interface CapturedImage {
  data: string;
  mimeType: string;
}

/**
 * Turn a capture failure reason into something actionable.
 *
 * The old message guessed ("may not have painted yet — retry") for every failure,
 * which is right for exactly one of these and actively misleading for the rest:
 * a tainted canvas fails the same way forever, so the advice to retry burned turns
 * on a capture that could never succeed.
 */
export function captureFailureHint(reason: string): string {
  switch (reason) {
    case 'taint':
      return (
        'An external resource tainted the canvas, so the browser refuses to read its ' +
        'pixels. Retrying will not help — find the non-`data:` URL in the DOM ' +
        '(an <img>, a CSS url(), a <video>) and inline or remove it. Meanwhile use ' +
        'previewEval to check structure instead of pixels.'
      );
    case 'no-response':
      return (
        'The preview never answered the capture request: either no capture handler is ' +
        'installed (an old build — recompile and re-open the preview) or the page is ' +
        'busy blocking the main thread. Check previewConsole for a stuck script.'
      );
    case 'zero-size':
      return (
        'The preview has no layout box yet — the window is not laid out, or the app ' +
        'renders into a zero-size container. Retry after a moment; if it persists, ' +
        'check the root element has a height (resizePreview can also give it room).'
      );
    case 'serialize-error':
      return (
        'Serializing the DOM for capture threw. Usually a node the cloner cannot handle ' +
        '(exotic embeds, a huge tree). Use previewEval to inspect structure instead.'
      );
    case 'img-load-error':
      return (
        'The serialized snapshot failed to load as an image — typically malformed markup ' +
        'in the DOM. Use previewEval to inspect structure instead.'
      );
    default:
      return `Capture failed (${reason}).`;
  }
}

/**
 * Open (or re-open) the preview window on the current build, and return where it landed.
 *
 * Re-creating the window remounts the iframe, which is how a preview picks up a new build —
 * so `compile` calls this too. Shared with the `preview` command rather than duplicated:
 * the window id, the preview principal and the permissions below are all load-bearing, and
 * a second copy of them that drifted would be its own bug.
 */
export async function openPreview(): Promise<{ previewUrl: string; windowId: string }> {
  const url = previewUrl();
  if (!url) throw new AppCommandError('No compiled output. Run compile first.');
  const proj = activeProject();
  const name = proj?.name ?? 'Preview';
  // Read project's app.json to get declared permissions for the preview iframe
  let permissions: PermissionEntry[] | undefined;
  if (proj) {
    const raw = await appStorage.readJsonOr<unknown>(`projects/${proj.id}/app.json`, null);
    if (raw != null) {
      const appJson = z.safeParse(ProjectAppJsonSchema, raw);
      if (appJson.success) {
        permissions = appJson.data.permissions;
      } else {
        // Previewing without the declared grants still works — the app just 403s
        // on its verbs — so this degrades rather than refusing to open. It has to
        // say so, though: "my app can't read storage in the preview" is otherwise
        // an unexplainable symptom of a typo in app.json.
        console.error(
          `[devtools] projects/${proj.id}/app.json failed validation — previewing with no declared permissions`,
          appJson.error.issues,
        );
      }
    }
  }
  // Address the window by an explicit, namespaced id. Left to the server, the id is
  // derived by slugging the title — and the title is the project name, so previewing a
  // clone of `ai-chat` produced the window id `ai-chat`, colliding with the *running*
  // app. Window registration is last-write-wins, so the preview silently replaced the
  // real app's window record (and its appId), severing the real app from its agent.
  const previewId = `devtools-preview-${proj?.id ?? 'scratch'}`;
  // Give the preview a principal of its own, derived from the project. `self` then
  // resolves inside it — so appStorage, appDb and app-scoped permissions actually run
  // before deploy instead of 403'ing — while the storage it reaches is a throwaway
  // namespace, not the deployed app's live data. The server refuses to route an app
  // agent to a `preview--*` identity, so this cannot displace the real app either.
  const previewAppId = proj ? `preview--${proj.id}` : undefined;
  // Close before create, unconditionally. `create` on an id that already exists is a
  // hard error server-side (features/window/create.ts) — not a replace — so the create
  // below would throw and take the whole `compile` command down with it, reported as
  // "compile failing" even though the build succeeded. Gating this on previewWindowId()
  // is not enough: that signal is set only here and cleared only in two catch blocks,
  // and nothing subscribes to window close, so it goes stale in both directions. Asking
  // the server to close is the only thing that knows the truth. A close that fails
  // because there was nothing there is the expected case, not an error.
  try {
    await invoke(`yaar://windows/${previewId}`, { action: 'close' });
  } catch {
    /* no such window — that is the normal first-open path */
  }
  const result = await invoke<{ windowId?: string }>(`yaar://windows/${previewId}`, {
    action: 'create',
    title: `${name} (preview)`,
    renderer: 'iframe',
    content: url,
    ...(previewAppId ? { appId: previewAppId } : {}),
    ...(permissions ? { permissions } : {}),
  });
  // Trust the id the server actually registered, not the one we asked for.
  const windowId = result?.windowId ?? previewId;
  setPreviewWindowId(windowId);
  return { previewUrl: url, windowId };
}

/**
 * Read the preview window: its metadata, and a screenshot of what it is rendering.
 *
 * Reading an iframe window emits a capture whose image the verb layer hands back
 * alongside the JSON, so `read` resolves to `{ data, images }` rather than the bare
 * metadata. A window with nothing to capture yet resolves to the metadata alone —
 * hence both shapes are accepted, and an empty `images` is a real answer ("nothing
 * painted"), not an error to be swallowed here.
 */
export async function readPreview(): Promise<{
  info: Record<string, unknown>;
  images: CapturedImage[];
}> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');

  let result: unknown;
  try {
    result = await read<unknown>(`yaar://windows/${wid}`);
  } catch {
    setPreviewWindowId(null);
    throw new AppCommandError('Preview window no longer exists.');
  }

  const wrapped = result as { data?: unknown; images?: CapturedImage[] } | undefined;
  const hasImages = Array.isArray(wrapped?.images);
  return {
    info: ((hasImages ? wrapped?.data : result) ?? {}) as Record<string, unknown>,
    images: hasImages ? (wrapped?.images ?? []) : [],
  };
}

/**
 * Evaluate a JS expression inside the preview iframe and return the result as text.
 *
 * Answers questions about a *running* preview that source alone cannot settle —
 * computed styles, element counts, live state — without the plant-a-debug-command,
 * recompile, read, remove, recompile round trip. Also the fallback when a screenshot
 * fails for good (a tainted canvas): structure is still checkable when pixels are not.
 *
 * The server refuses this for anything that is not a devtools preview window, so it
 * is not a door into the user's installed apps.
 */
function formatEvaluationContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    const json = JSON.stringify(content, null, 2);
    return json === undefined ? String(content) : json;
  } catch {
    return String(content);
  }
}

function logPreviewEvaluation(kind: 'input' | 'result' | 'error', content: unknown): void {
  addConsoleEntry({
    level: kind === 'error' ? 'error' : 'info',
    // Keep the complete expression/result in a single argument: ConsolePanel renders
    // args verbatim with pre-wrap, so agents can recover precisely what was evaluated.
    args: [`[preview eval ${kind}]\n${formatEvaluationContent(content)}`],
    timestamp: Date.now(),
    source: 'evaluation',
  });
}

export async function previewEvaluate(expression: string): Promise<unknown> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
  logPreviewEvaluation('input', expression);
  try {
    const result = await invoke<unknown>(`yaar://windows/${wid}`, { action: 'app_eval', expression });
    logPreviewEvaluation('result', result);
    return result;
  } catch (err) {
    const message = errMsg(err);
    logPreviewEvaluation('error', message);
    throw new AppCommandError(`Preview eval failed: ${message}`);
  }
}
