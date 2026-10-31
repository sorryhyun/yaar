export {};
import { errMsg } from '@bundled/yaar';
import { bundledLibraries, checkPermissions } from '@bundled/yaar-dev';
import { requireProject, files } from '../core';
import { isGeneratedPath, projectPath } from '../lib/paths';
import { collectVerbUses, type VerbUse } from '../lib/permission-uses';
import {
  checkDocMentions,
  protocolSizeReport,
  type DocMention,
  type ProtocolDoc,
  type ProtocolSizeReport,
} from '../lib/protocol-report';
import { findRealStoragePaths, type StorageReach } from '../lib/storage-reach';
import { findStoragePolling, type StoragePoll } from '../lib/storage-polling';
import {
  cssClassReport,
  findStaleFileRefs,
  type CssClassReport,
  type StaleFileRef,
} from '../lib/source-scan';
import { readFileText } from './files';
import { isAppSource } from './storage-watch';

// Static checks over the active project's text that neither the type checker nor the
// bundler makes: comments and docs naming source files that are gone, CSS classes
// that are defined but never named, or named but never styled, `yaar://` uses that
// app.json does not grant, and timer loops that poll storage.

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
/** Test files never ship, so what they reach needs no grant. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const MAX_LISTED = 40;

export interface PermissionReport {
  /** Uses app.json does not grant — each one is refused (403) when it runs. */
  missing: VerbUse[];
  /** Entries the server reads differently from how they are written — dropped or narrowed. */
  problems?: string[];
}

export interface ProjectCheck {
  staleFileRefs: StaleFileRef[];
  css: CssClassReport;
  permissions?: PermissionReport;
  /** Timer loops that re-read storage — a warning: `subscribe` delivers the change instead. */
  storagePolling?: StoragePoll[];
  /** Literal paths into real storage: a preview that writes one writes the real file. */
  previewEscapes?: StorageReach[];
  /** What the compiled protocol costs a reader. */
  protocol?: ProtocolSizeReport;
  /** Commands, state keys and params the docs name that the protocol does not declare. */
  docMentions?: DocMention[];
  /** Why `protocol` and `docMentions` are absent: no compiled protocol to read. */
  protocolNote?: string;
  /** Why `permissions` is absent: the server could not be asked. */
  permissionsNote?: string;
  /** Entries past the per-list cap, by list. */
  omitted?: Record<string, number>;
  /** Why the SDK class list was unavailable, when `unknownSdk` could not be checked. */
  sdkNote?: string;
}

let sdkClassCache: string[] | null = null;

/** The `y-*` classes the design tokens define, read once per session. */
async function sdkClasses(): Promise<{ list: string[]; error?: string }> {
  if (sdkClassCache) return { list: sdkClassCache };
  try {
    const raw = JSON.stringify(await bundledLibraries('design-tokens'));
    const list = [...new Set(raw.match(/(?<![\w-])y-[a-z][\w-]*/g) ?? [])];
    if (list.length > 0) sdkClassCache = list;
    return { list };
  } catch (err) {
    return { list: [], error: errMsg(err) };
  }
}

/**
 * The source's verb uses that app.json does not grant. The uses are found here (lexically,
 * `lib/permission-uses.ts`); the verdict is the server's, from the same matching the door
 * refuses with, so this cannot disagree with the 403 it predicts.
 */
async function permissionReport(
  projectId: string,
  sources: { path: string; text: string }[],
): Promise<{ permissions?: PermissionReport; permissionsNote?: string }> {
  const { uses, distinct } = collectVerbUses(sources);
  try {
    const answer = await checkPermissions(projectPath(projectId), distinct);
    if (!answer.success || !answer.results) {
      return { permissionsNote: `permissions not checked: ${answer.error ?? 'no answer'}` };
    }
    const denied = new Set(
      answer.results.filter((r) => r.allowed === false).map((r) => `${r.verb} ${r.uri}`),
    );
    return {
      permissions: {
        missing: uses.filter((u) => denied.has(`${u.verb} ${u.uri}`)),
        ...(answer.problems?.length ? { problems: answer.problems } : {}),
      },
    };
  } catch (err) {
    return { permissionsNote: `permissions not checked: ${errMsg(err)}` };
  }
}

/** The last compile's protocol.json with its descriptions, or why there is none. */
async function compiledProtocol(): Promise<{ doc: ProtocolDoc } | { note: string }> {
  const text = await readFileText('dist/protocol.json');
  if (text === null) return { note: 'protocol not checked: run build/compile first' };
  try {
    return { doc: JSON.parse(text) as ProtocolDoc };
  } catch (err) {
    return { note: `protocol not checked: dist/protocol.json is unreadable (${errMsg(err)})` };
  }
}

export async function checkProject(): Promise<ProjectCheck> {
  const proj = requireProject();
  const entries = files().filter((f) => !f.isDirectory && !isGeneratedPath(f.path));
  const paths = entries.map((f) => f.path);
  const wanted = paths.filter((p) => SOURCE_EXT.test(p) || p.endsWith('.css') || p.endsWith('.md'));
  const texts = await Promise.all(
    wanted.map(async (path) => ({ path, text: (await readFileText(path)) ?? '' })),
  );
  const shipped = texts.filter((t) => SOURCE_EXT.test(t.path) && !TEST_FILE.test(t.path));
  const [sdk, perms] = await Promise.all([sdkClasses(), permissionReport(proj.id, shipped)]);
  const staleFileRefs = findStaleFileRefs(texts, paths);
  const storagePolling = findStoragePolling(shipped);
  const previewEscapes = findRealStoragePaths(shipped.filter((t) => isAppSource(t.path)));
  const compiled = await compiledProtocol();
  const docs = texts.filter((t) => t.path.endsWith('.md'));
  const css = cssClassReport(
    texts.filter((t) => t.path.endsWith('.css')),
    texts.filter((t) => SOURCE_EXT.test(t.path)),
    sdk.list,
  );
  const omitted: Record<string, number> = {};
  const cap = <T>(name: string, list: T[]): T[] => {
    if (list.length > MAX_LISTED) omitted[name] = list.length - MAX_LISTED;
    return list.slice(0, MAX_LISTED);
  };
  return {
    staleFileRefs: cap('staleFileRefs', staleFileRefs),
    css: {
      unused: cap('unused', css.unused),
      unstyled: cap('unstyled', css.unstyled),
      unknownSdk: cap('unknownSdk', css.unknownSdk),
    },
    ...(perms.permissions
      ? {
          permissions: {
            ...perms.permissions,
            missing: cap('permissions.missing', perms.permissions.missing),
          },
        }
      : {}),
    ...(storagePolling.length ? { storagePolling: cap('storagePolling', storagePolling) } : {}),
    ...(previewEscapes.length ? { previewEscapes: cap('previewEscapes', previewEscapes) } : {}),
    ...('doc' in compiled
      ? {
          protocol: protocolSizeReport(compiled.doc),
          docMentions: cap('docMentions', checkDocMentions(docs, compiled.doc)),
        }
      : { protocolNote: compiled.note }),
    ...(perms.permissionsNote ? { permissionsNote: perms.permissionsNote } : {}),
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(sdk.list.length === 0
      ? {
          sdkNote: `y-* classes were not checked: ${sdk.error ?? 'the design-token list had none'}`,
        }
      : {}),
  };
}

/** One line per non-empty finding, for a result that only points at `build/check`. */
export function summarizeCheck(check: ProjectCheck): string[] {
  const lines: string[] = [];
  const missing = check.permissions?.missing.length ?? 0;
  if (missing) lines.push(`${missing} yaar:// use(s) app.json does not grant — each will 403`);
  if (check.permissions?.problems?.length) {
    lines.push(
      `${check.permissions.problems.length} app.json permission entry(ies) not honoured as written`,
    );
  }
  if (check.staleFileRefs.length) {
    lines.push(
      `${check.staleFileRefs.length} comment/doc reference(s) to source files that do not exist`,
    );
  }
  if (check.css.unknownSdk.length) {
    lines.push(`${check.css.unknownSdk.length} y-* class(es) that the SDK does not define`);
  }
  if (check.css.unstyled.length)
    lines.push(`${check.css.unstyled.length} class(es) used with no CSS rule`);
  if (check.css.unused.length) lines.push(`${check.css.unused.length} CSS class(es) nothing names`);
  if (check.docMentions?.length) {
    lines.push(`${check.docMentions.length} doc mention(s) of something the protocol lacks`);
  }
  if (check.previewEscapes?.length) {
    lines.push(
      `${check.previewEscapes.length} literal path(s) into real storage — a preview writing one writes the real file`,
    );
  }
  if (check.storagePolling?.length) {
    lines.push(
      `${check.storagePolling.length} timer loop(s) re-reading storage — subscribe instead (multi-window-sync topic)`,
    );
  }
  return lines;
}
