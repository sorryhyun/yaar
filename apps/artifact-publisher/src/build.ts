// Clone an installed app's source into this app's storage and compile it there, so its
// dist/index.html sits under the agent's working directory where the Artifact tool can
// reach it. Same clone payload and binary handling as devtools' cloneApp.

import { appStorage, errMsg, invoke } from '@bundled/yaar';
import { compile } from '@bundled/yaar-dev';
import { setActivity, setFailure, startStep } from './store';

interface CloneFile {
  path: string;
  content: string;
  /** Set when `content` is base64 (images, fonts, wasm): writing it as utf-8 corrupts it. */
  encoding?: 'base64';
}

interface ClonePayload {
  files?: CloneFile[];
}

/** A failed build, with every compiler message kept for the UI and the agent. */
export class BuildError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join('\n'));
  }
}

export function projectDir(appId: string): string {
  return `projects/${appId}`;
}

export function outputPath(appId: string): string {
  return `${projectDir(appId)}/dist/index.html`;
}

/** Drop a previous clone so files the app has since deleted do not linger in the build. */
async function clearProject(appId: string): Promise<void> {
  let entries: Awaited<ReturnType<typeof appStorage.list>>;
  try {
    entries = await appStorage.list('projects');
  } catch (e) {
    // No projects/ folder before the first build.
    if (/not found/i.test(errMsg(e))) return;
    throw e;
  }
  const exists = entries.some(
    (e) => e.isDirectory && e.path.replace(/\/$/, '').split('/').pop() === appId,
  );
  if (exists) await appStorage.remove(projectDir(appId));
}

/**
 * Clone and compile `appId`. Resolves with the storage-relative path of the compiled
 * page; throws BuildError with the compiler's messages. Leaves `activity` cleared and,
 * on failure, `failure` set.
 */
export async function buildApp(appId: string): Promise<{ path: string; warnings: string[] }> {
  if (!/^[a-z][a-z0-9-]*$/.test(appId)) throw new BuildError([`Invalid app id: ${appId}`]);
  setFailure(null);
  try {
    startStep(appId, 'cloning');
    const payload = await invoke<ClonePayload>(`yaar://apps/${appId}`, { action: 'clone' });
    const files = payload?.files ?? [];
    if (!files.some((f) => f.path === 'src/main.ts')) {
      throw new BuildError([`"${appId}" has no src/main.ts to build`]);
    }
    await clearProject(appId);
    for (const file of files) {
      await appStorage.save(
        `${projectDir(appId)}/${file.path}`,
        file.content,
        file.encoding ? { encoding: file.encoding } : undefined,
      );
    }

    startStep(appId, 'compiling');
    const result = await compile(projectDir(appId));
    if (!result.success) {
      throw new BuildError(
        result.errors?.length ? result.errors : [result.error ?? 'Compile failed'],
      );
    }
    setActivity(null);
    return { path: outputPath(appId), warnings: result.warnings ?? [] };
  } catch (e) {
    const messages = e instanceof BuildError ? e.messages : [errMsg(e)];
    setActivity(null);
    setFailure({ appId, stage: 'build', messages });
    throw e instanceof BuildError ? e : new BuildError(messages);
  }
}
