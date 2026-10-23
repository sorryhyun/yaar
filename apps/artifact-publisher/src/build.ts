// Clone an installed app's source into this app's storage and compile it there, so its
// dist/index.html sits under the agent's working directory where the Artifact tool can
// reach it. Same clone payload and binary handling as devtools' cloneApp.

import { appStorage, bytesToBase64, errMsg, invoke } from '@bundled/yaar';
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

/** A file published beside the page through the Artifact tool's `files`. */
export interface PageAsset {
  /** Where it sits, relative to this app's storage root. */
  path: string;
  /** The path the page links it by, relative to the page. */
  publishedAs: string;
  contentType: string;
}

/**
 * A font the page links from YAAR's web root, such as the design tokens'
 * `url('/NanumSquareNeoOTF-Rg.otf')`. The Artifact host serves none of them, so a
 * published page would fall back to the system font, Hangul included.
 */
const ROOT_FONT = /url\((['"]?)\/([\w.-]+\.(otf|ttf|woff2?))\1\)/g;
const FONT_TYPES: Record<string, string> = {
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** Copy each root-linked font next to the compiled page and link it relatively. */
async function bundleRootFonts(appId: string): Promise<PageAsset[]> {
  const page = outputPath(appId);
  const html = await appStorage.read(page);
  const fonts = new Map<string, string>();
  for (const m of html.matchAll(ROOT_FONT)) fonts.set(m[2], FONT_TYPES[m[3]]);
  const assets: PageAsset[] = [];
  for (const [file, contentType] of fonts) {
    const res = await fetch(`/${file}`);
    if (!res.ok) throw new BuildError([`Could not copy /${file} for the page: HTTP ${res.status}`]);
    const path = `${projectDir(appId)}/dist/${file}`;
    await appStorage.save(path, bytesToBase64(await res.arrayBuffer()), { encoding: 'base64' });
    assets.push({ path, publishedAs: file, contentType });
  }
  if (assets.length) await appStorage.save(page, html.replace(ROOT_FONT, 'url($1$2$1)'));
  return assets;
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
 * page and the files to publish beside it; throws BuildError with the compiler's
 * messages. Leaves `activity` cleared and, on failure, `failure` set.
 */
export async function buildApp(
  appId: string,
): Promise<{ path: string; assets: PageAsset[]; warnings: string[] }> {
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
    const assets = await bundleRootFonts(appId);
    setActivity(null);
    return { path: outputPath(appId), assets, warnings: result.warnings ?? [] };
  } catch (e) {
    const messages = e instanceof BuildError ? e.messages : [errMsg(e)];
    setActivity(null);
    setFailure({ appId, stage: 'build', messages });
    throw e instanceof BuildError ? e : new BuildError(messages);
  }
}
