// Clone an installed app's source into this app's storage and compile it there, so its
// dist/index.html sits under the agent's working directory where the Artifact tool can
// reach it. Same clone payload and binary handling as devtools' cloneApp.

import { appStorage, bytesToBase64, errMsg, fonts, invoke } from '@bundled/yaar';
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
 * `url('/NanumSquareNeoOTF-Rg.otf') format('opentype')`. The Artifact host serves none of
 * them, so a published page would fall back to the system font, Hangul included.
 */
const ROOT_FONT = /url\((['"]?)\/([\w.-]+\.(otf|ttf|woff2?))\1\)(\s*format\((['"]?)[\w-]+\5\))?/g;
const FONT_TYPES: Record<string, string> = {
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** The most distinct characters one `fonts.inline` call takes (the server's MAX_SUBSET_CHARS). */
const MAX_SUBSET_CHARS = 5000;

/**
 * What the published fonts cover: the 2,350 Hangul syllables of KS X 1001 (the set
 * nearly all Korean text stays within), its symbol and jamo rows, ASCII and Latin-1,
 * then whatever else the page's own source spells, up to the subset limit. A character
 * outside it falls back to the system font: the subset's cmap claims only these.
 */
function subsetText(html: string): string {
  const chars = new Set<string>();
  const euckr = new TextDecoder('euc-kr');
  const rows = [0xa1, 0xa4];
  for (let row = 0xb0; row <= 0xc8; row++) rows.push(row);
  for (const row of rows) {
    for (let cell = 0xa1; cell <= 0xfe; cell++) {
      const ch = euckr.decode(new Uint8Array([row, cell]));
      if (ch !== '\ufffd') chars.add(ch);
    }
  }
  for (let cp = 0x20; cp <= 0xff; cp++) {
    if (cp < 0x7f || cp > 0x9f) chars.add(String.fromCodePoint(cp));
  }
  for (const ch of html) {
    if (chars.size >= MAX_SUBSET_CHARS) break;
    if (/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch)) chars.add(ch);
  }
  return [...chars].join('');
}

/**
 * Publish the root-linked fonts beside the page as WOFF2 subsets, and link them relatively.
 *
 * A whole NanumSquareNeo face is ~1.6 MB and the tokens link four, so copying them made
 * every publish carry 6.6 MB of fonts. Subsetted to `subsetText` and WOFF2'd, a face is
 * ~130 KB. Light and Extra Bold are linked to the Regular and Bold subsets: apps barely
 * use them, and two files instead of four halves what is left. A font the server's
 * catalog does not serve is copied whole, as before.
 */
async function bundleRootFonts(appId: string): Promise<PageAsset[]> {
  const page = outputPath(appId);
  const html = await appStorage.read(page);
  const linked = new Map<string, string>();
  for (const m of html.matchAll(ROOT_FONT)) linked.set(m[2], m[3]);
  if (!linked.size) return [];

  const catalog = await fonts.faces();
  const text = subsetText(html);
  const dist = `${projectDir(appId)}/dist`;
  const assets = new Map<string, PageAsset>();
  /** Root file name -> what the page links instead; a file copied whole keeps its link, made relative. */
  const relink = new Map<string, string>();

  const byFamily = new Map<string, Map<string, number>>();
  for (const [file, ext] of linked) {
    const face = catalog.faces.find((f) => f.url === `/${file}`);
    if (face) {
      const weights = byFamily.get(face.family) ?? new Map<string, number>();
      weights.set(file, face.weight <= 500 ? 400 : 700);
      byFamily.set(face.family, weights);
      continue;
    }
    const res = await fetch(`/${file}`);
    if (!res.ok) throw new BuildError([`Could not copy /${file} for the page: HTTP ${res.status}`]);
    await appStorage.save(`${dist}/${file}`, bytesToBase64(await res.arrayBuffer()), {
      encoding: 'base64',
    });
    assets.set(file, { path: `${dist}/${file}`, publishedAs: file, contentType: FONT_TYPES[ext] });
  }

  for (const [family, files] of byFamily) {
    const subset = await fonts.inline(text, {
      family,
      weights: [...new Set(files.values())],
      woff2: true,
    });
    for (const [file, weight] of files) {
      const face = subset.faces.find((f) => f.weight === weight);
      if (!face) throw new BuildError([`Could not subset ${family} ${weight} for the page`]);
      const name = `${family.replace(/[^\w-]/g, '')}-${face.servedWeight}.woff2`;
      if (!assets.has(name)) {
        await appStorage.save(
          `${dist}/${name}`,
          face.dataUrl.slice(face.dataUrl.indexOf(',') + 1),
          {
            encoding: 'base64',
          },
        );
        assets.set(name, { path: `${dist}/${name}`, publishedAs: name, contentType: 'font/woff2' });
      }
      relink.set(file, `url('${name}') format('woff2')`);
    }
  }

  await appStorage.save(
    page,
    html.replace(
      ROOT_FONT,
      (whole, _q, file: string) => relink.get(file) ?? whole.replace(`/${file}`, file),
    ),
  );
  return [...assets.values()];
}

interface AgentDocs {
  skill: string | null;
  prompt: string | null;
  topics: { name: string; description: string; body: string }[];
}

/** A doc's `key: value` frontmatter and the body after it; no frontmatter is all body. */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return { fields, body: text.slice(m[0].length).trim() };
}

async function readOr(path: string): Promise<string | null> {
  try {
    return await appStorage.read(path);
  } catch {
    return null;
  }
}

/**
 * The manual YAAR's app agent reads, from the clone: the skill, the prompt, and the
 * `agent/docs/` topics a runtime caller is indexed (`audience: agent|both`, as the server's
 * `runtimeDocs` filters). Null when the app ships none of it.
 */
async function readAgentDocs(appId: string, meta: { agent?: Record<string, unknown> }) {
  const dir = projectDir(appId);
  const at = (key: string, fallback: string) => {
    const p = meta.agent?.[key];
    return `${dir}/${typeof p === 'string' && p ? p : fallback}`;
  };
  const docs: AgentDocs = {
    skill: await readOr(at('skill', 'agent/SKILL.md')),
    prompt: await readOr(at('prompt', 'agent/prompt.md')),
    topics: [],
  };
  const entries = await appStorage.list(`${dir}/agent/docs`).catch(() => []);
  for (const e of entries) {
    // A listing's `path` may be the bare name or the full path; the name is all it needs.
    const file = e.path.replace(/\/$/, '').split('/').pop() ?? '';
    if (e.isDirectory || !file.endsWith('.md')) continue;
    const text = await readOr(`${dir}/agent/docs/${file}`);
    if (text === null) continue;
    const { fields, body } = splitFrontmatter(text);
    if (fields.audience === 'dev') continue;
    const name = file.replace(/\.md$/, '');
    const description =
      fields.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
    docs.topics.push({ name, description: description.trim(), body });
  }
  docs.topics.sort((a, b) => a.name.localeCompare(b.name));
  return docs.skill || docs.prompt || docs.topics.length ? docs : null;
}

/**
 * Tell an agent reading the page how to drive it, and hand it the manual. In a claude.ai
 * conversation about the Artifact, Claude gets this HTML and runs it in its own headless
 * browser, where the app protocol has no desktop to answer and nothing else in a
 * multi-megabyte bundle says it exists, so it clicked through the UI instead. Nor could it
 * read the app's docs, which YAAR serves only through verbs. `window.yaarApp` is installed
 * outside YAAR by the protocol script (shared/iframe-scripts/app-protocol.ts), and its
 * `docs()` reads the JSON embedded here.
 */
async function annotateForAgents(appId: string): Promise<void> {
  const page = outputPath(appId);
  const html = await appStorage.read(page);
  let name = appId;
  let meta: { name?: unknown; agent?: Record<string, unknown> } = {};
  try {
    meta = JSON.parse(await appStorage.read(`${projectDir(appId)}/app.json`));
    if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim();
  } catch {
    // No readable app.json: the id names the app well enough.
  }
  const docs = await readAgentDocs(appId, meta);
  // `--` cannot appear inside an HTML comment.
  const safe = (s: string) => s.replace(/-{2,}/g, '-');
  const note =
    `<!-- YAAR app "${safe(appId)}" (${safe(name)}). Agents: drive this page through ` +
    `window.yaarApp instead of clicking. yaarApp.manifest() lists every state key and ` +
    `command with its JSON schema; await yaarApp.state(key) reads one, await ` +
    `yaarApp.command(name, params) runs one, await yaarApp.describe(name) explains one. ` +
    (docs
      ? `await yaarApp.docs() returns the app's manual { skill, prompt, topics } (also in ` +
        `the yaar-app-agent-docs script below), and yaarApp.docs(name) one topic: where the ` +
        `manual says read("yaar://apps/${safe(appId)}/docs/<name>") or ".../skill", use those. `
      : '') +
    `It is installed when the page runs outside YAAR (the claude.ai viewer, or a top window). ` +
    `There, storage paths (app and shared/) are kept in this browser's IndexedDB, and YAAR ` +
    `verbs, agents and server routes are not available. -->`;
  // `<` escaped so no `</script>` or `<!--` in a doc can end the element early.
  const embedded = docs
    ? `\n<script type="application/json" id="yaar-app-agent-docs">${JSON.stringify(docs).replace(/</g, '\\u003c')}</script>`
    : '';
  const at = html.indexOf('<head>');
  if (at < 0) return;
  const end = at + '<head>'.length;
  await appStorage.save(page, `${html.slice(0, end)}\n${note}${embedded}${html.slice(end)}`);
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
    await annotateForAgents(appId);
    setActivity(null);
    return { path: outputPath(appId), assets, warnings: result.warnings ?? [] };
  } catch (e) {
    const messages = e instanceof BuildError ? e.messages : [errMsg(e)];
    setActivity(null);
    setFailure({ appId, stage: 'build', messages });
    throw e instanceof BuildError ? e : new BuildError(messages);
  }
}
