export {};
import { batch } from '@bundled/solid-js';
import { errMsg, invoke, AppCommandError } from '@bundled/yaar';
import {
  compile as devCompile,
  typecheck as devTypecheck,
  deploy as devDeploy,
} from '@bundled/yaar-dev';
import {
  activeProject,
  setCompileStatus,
  setCompileErrors,
  setStatusText,
  setPreviewUrl,
  setConsoleLogs,
  setDiagnostics,
  setStaticProtocol,
  previewWindowId,
  setPreviewWindowId,
} from '../core';
import { projectPath } from '../lib/paths';
import { parseDiagnostics } from '../lib/parse-diagnostics';

// Build, type check and deploy — the calls that talk to the dev server and
// report their outcome through the compile/diagnostic signals.

export async function compile(): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  setCompileStatus('compiling');
  setCompileErrors([]);
  setStaticProtocol(null);
  setStatusText('Compiling...');
  try {
    const result = await devCompile(projectPath(proj.id), { title: proj.name });
    if (result.success) {
      // Retain the statically extracted manifest so the `manifest` command and
      // the compile drift check can compare it against the running preview.
      setStaticProtocol({
        protocol: result.protocol ?? null,
        reported: result.protocol !== undefined,
      });
      batch(() => {
        setCompileStatus('success');
        setCompileErrors([]);
        setPreviewUrl(result.previewUrl ?? null);
        setConsoleLogs([]);
        setStatusText('Compilation successful');
      });
    } else {
      const errors = result.errors ?? [
        (result as { error?: string }).error ?? 'Compilation failed',
      ];
      batch(() => {
        setCompileStatus('error');
        setCompileErrors(errors);
        setStatusText(errors.join('\n'));
      });
    }
  } catch (err) {
    const msg = errMsg(err);
    batch(() => {
      setCompileStatus('error');
      setCompileErrors([msg]);
      setStatusText(`Compile error: ${msg}`);
    });
  }
}

export async function typecheck(): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  setStatusText('Type checking...');
  try {
    const result = await devTypecheck(projectPath(proj.id));
    if (result.success) {
      setDiagnostics([]);
      setStatusText('No type errors');
    } else {
      const raw = result.diagnostics ?? [(result as { error?: string }).error ?? 'Unknown error'];
      const parsed = parseDiagnostics(raw.join('\n'));
      setDiagnostics(
        parsed.length > 0
          ? parsed
          : raw.map((m) => ({ file: '?', line: 0, message: m, severity: 'error' as const })),
      );
      setStatusText(`${parsed.length || raw.length} type error(s)`);
    }
  } catch (err) {
    setStatusText(`Typecheck error: ${errMsg(err)}`);
  }
}

/**
 * Deploy the active project, or throw saying why not.
 *
 * On success the preview window is closed: it renders the pre-deploy build under a
 * throwaway principal, so leaving it up invites confirming a deploy against stale pixels.
 * The server does the same for the *installed* app's own windows and reports which ones
 * in `closedWindows`; this window is never one of them, so self-deploying is safe.
 *
 * A failed deploy used to be written to the status bar and then swallowed — the caller got
 * back the same `undefined` a successful one returns. An agent, which cannot read the status
 * bar, was told nothing and moved on believing it had shipped. The server refusing to deploy
 * type-broken code only helps if the refusal reaches whoever asked.
 */
export async function deploy(opts: {
  appId: string;
  name?: string;
  icon?: string;
  description?: string;
  message?: string;
  skipTypecheck?: boolean;
  allowProtocolShrink?: boolean;
}): Promise<{
  appId: string;
  name: string;
  previewClosed?: boolean;
  closedWindows?: string[];
}> {
  const proj = activeProject();
  if (!proj) throw new AppCommandError('No active project. Open or create one first.');
  setStatusText('Deploying...');
  let result: Awaited<ReturnType<typeof devDeploy>>;
  try {
    // Permissions and other metadata are read from sandbox's app.json by the server
    result = await devDeploy(projectPath(proj.id), opts);
  } catch (err) {
    setStatusText(`Deploy failed: ${errMsg(err)}`);
    throw new AppCommandError(`Deploy failed: ${errMsg(err)}`);
  }
  if (!result.success) {
    const reason = result.error ?? 'Unknown error';
    setStatusText(`Deploy failed: ${reason}`);
    throw new AppCommandError(`Deploy failed: ${reason}`);
  }
  const name = result.name ?? opts.appId;

  // Close the preview once the deploy has actually landed. A preview is a window onto a
  // *build*, not onto the app: it runs under the throwaway `preview--{projectId}` principal
  // against a sandbox that deploy has now superseded. Left open it keeps rendering the
  // pre-deploy bundle under a title that reads like the shipped app, which is exactly the
  // window someone screenshots to confirm a deploy worked.
  //
  // Best-effort, and only on success: a close that fails (or a preview that was never open)
  // must not turn a deploy that shipped into a reported failure. The signal is cleared
  // regardless — nothing subscribes to window close, so it goes stale in both directions,
  // and leaving it set would point the preview commands at a window that is gone.
  let previewClosed = false;
  const wid = previewWindowId();
  if (wid) {
    try {
      await invoke(`yaar://windows/${wid}`, { action: 'close' });
      previewClosed = true;
    } catch {
      /* already gone, or the server refused — the deploy still succeeded */
    }
    setPreviewWindowId(null);
  }

  // The server closes windows still running the pre-deploy bundle (see
  // features/apps/retire.ts). Say so: a window disappearing at the moment of a deploy
  // with nothing to explain it reads as a crash.
  const closedWindows = result.closedWindows ?? [];
  setStatusText(
    closedWindows.length > 0
      ? `Deployed as "${name}" — closed ${closedWindows.length} stale window(s)`
      : `Deployed as "${name}"`,
  );
  return {
    appId: result.appId ?? opts.appId,
    name,
    ...(previewClosed ? { previewClosed } : {}),
    ...(closedWindows.length > 0 ? { closedWindows } : {}),
  };
}
