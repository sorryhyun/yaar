/**
 * Static guardrails for app source under `apps/*​/src` (proposal §3.1 of
 * docs/proposals/app_library_integration_proposal.md).
 *
 * Each rule scans for a high-confidence anti-pattern and is tagged either
 * ERROR (violation count is currently zero — keep it that way) or ADVISORY
 * (violations still exist, so warn but don't fail). The proposal's promotion
 * rule is: start every rule advisory; promote to hard once its violation
 * count reaches zero. The per-rule summary printed at the end is what tells
 * you a rule is ready for promotion.
 *
 * Usage:
 *   bun run scripts/check/apps.ts             # scan every app
 *   bun run scripts/check/apps.ts apps/memo   # scan specific apps or files
 *   bun run scripts/check/apps.ts --quiet     # only print violations
 *   bun run scripts/check/apps.ts --strict    # fail on advisory rules too
 *
 * Exit code: 1 if any ERROR rule has violations (or any rule, under --strict).
 *
 * Source text is comment- and string-stripped (with offsets preserved) before
 * matching, so a `javascript:alert(1)` inside a comment or a string literal is
 * not mistaken for a real native-dialog call.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
// The one parser both the runtime and this lint read topics with — a leaf module with
// no imports, so pulling it in does not boot the server's config. See its header.
// The chrome the platform injects, parsed once so `local-chrome-clone` can compare
// an app's rule blocks against the real y-* declarations rather than a hand-kept list.
import { YAAR_APP_TOKENS_CSS } from '../../packages/shared/src/design/app-css.ts';
import {
  AGENT_DOCS_DIR,
  DOC_SLUG_RE,
  DOC_DESCRIPTION_MAX,
  DOC_AUDIENCES,
  parseDocFrontmatter,
} from '../../packages/server/src/features/apps/doc-frontmatter.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

type Severity = 'ERROR' | 'ADVISORY';

interface Violation {
  file: string;
  line: number;
  message: string;
}

interface Rule {
  id: string;
  severity: Severity;
  title: string;
  /** Runs against the comment/string-stripped source; `raw` is the original. */
  scan(code: string, raw: string, file: string): Violation[];
}

// ---------------------------------------------------------------------------
// Source normalization
// ---------------------------------------------------------------------------

/**
 * Blank out comments and string literal bodies, replacing each removed character
 * with a space (newlines preserved) so byte offsets and line numbers still match
 * the original file.
 *
 * Template literals are handled structurally: only the *text* segments are
 * blanked, while `${...}` interpolations are scanned as real code. Solid apps
 * put most of their logic inside `html` tagged templates, so blanking whole
 * template literals would hide nearly every call site in the codebase.
 *
 * Regex literals are also recognized, so a pattern like `/"/g` isn't mistaken
 * for an opening quote that swallows the rest of the file.
 */
function stripCommentsAndStrings(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  // A `/` starts a regex literal (rather than division) when the previous
  // significant character can't end an expression.
  const regexAllowedBefore = /[(,=:[!&|?{};+\-*%~^<>\n]/;
  const prevSignificant = (at: number): string => {
    for (let k = at - 1; k >= 0; k--) {
      if (!/\s/.test(src[k]) || src[k] === '\n') return src[k];
    }
    return '\n';
  };

  /** 'template' = inside template text; 'interp' = inside a `${}` expression. */
  type Frame = { kind: 'template' } | { kind: 'interp'; braces: number };
  const stack: Frame[] = [];

  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const ch = src[i];
    const next = src[i + 1];

    if (top?.kind === 'template') {
      if (ch === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        i++;
      } else if (ch === '$' && next === '{') {
        stack.push({ kind: 'interp', braces: 0 });
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && regexAllowedBefore.test(prevSignificant(i))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === ch) break;
        j++;
      }
      // Keep the delimiters, blank the body — a bare `''` stays syntactically visible.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i++;
      continue;
    }
    if (top?.kind === 'interp') {
      if (ch === '{') top.braces++;
      else if (ch === '}') {
        if (top.braces === 0) {
          stack.pop();
          i++;
          continue;
        }
        top.braces--;
      }
    }
    i++;
  }
  return out.join('');
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function lineTextAt(raw: string, line: number): string {
  return (raw.split('\n')[line - 1] ?? '').trim();
}

// ---------------------------------------------------------------------------
// Rule 1: web storage APIs
// ---------------------------------------------------------------------------

const storageRule: Rule = {
  id: 'no-web-storage',
  severity: 'ERROR',
  title: '`localStorage` / `sessionStorage` — use `appStorage` / `appDb` from @bundled/yaar',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    for (const m of code.matchAll(/\b(localStorage|sessionStorage)\b/g)) {
      const line = lineOf(code, m.index!);
      violations.push({ file, line, message: `${m[1]} — ${lineTextAt(raw, line)}` });
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Rule 2: promise-based sleep wrappers
// ---------------------------------------------------------------------------

/**
 * Flags `new Promise(r => setTimeout(r, ms))`-shaped sleeps, which `wait()`
 * replaces. Deliberately does NOT flag a timeout *race* whose resolve carries a
 * fallback value (e.g. `new Promise(resolve => setTimeout(() => resolve({...}), ms))`)
 * — that expresses a deadline with a default, which `wait()` cannot express.
 * The discriminator is whether resolve is called with an argument.
 */
const sleepRule: Rule = {
  id: 'no-promise-sleep',
  severity: 'ERROR',
  title: '`new Promise(r => setTimeout(r, ms))` — use `wait(ms)` from @bundled/yaar',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    // `new Promise<T>((resolve) => ...` / `new Promise(r =>` — capture the resolve param.
    const promiseRe =
      /new\s+Promise\s*(?:<[^;{]*?>)?\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>/g;

    for (const m of code.matchAll(promiseRe)) {
      const resolveName = m[1] ?? m[2];
      const body = code.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const timeoutAt = body.search(/\bsetTimeout\s*\(/);
      if (timeoutAt === -1 || timeoutAt > 80) continue; // setTimeout must be the immediate body

      // Bare pass-through: setTimeout(resolve, ms)
      const passThrough = new RegExp(`\\bsetTimeout\\s*\\(\\s*${resolveName}\\s*,`).test(body);
      // Wrapped call: look at the first `resolve(...)` and check for an argument.
      const call = body.match(new RegExp(`\\b${resolveName}\\s*\\(([^)]*)\\)`));
      const resolvesWithValue = call ? call[1].trim().length > 0 : false;

      if (!passThrough && !call) continue; // resolve isn't wired to the timer at all
      if (resolvesWithValue) continue; // timeout race with a fallback value — legitimate

      const line = lineOf(code, m.index!);
      violations.push({
        file,
        line,
        message: `promise sleep via setTimeout(${resolveName}) — ${lineTextAt(raw, line)}`,
      });
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Rule 3: native dialogs (binding-aware)
// ---------------------------------------------------------------------------

const DIALOG_NAMES = ['alert', 'confirm', 'prompt'];

/**
 * Collect identifiers bound anywhere in the file: imports (named, default,
 * namespace, aliased), declarations, destructuring targets, and function
 * parameter names. A bare `prompt()` call is only a native-dialog call if the
 * name is NOT bound locally — `apps/anima` imports a Solid signal accessor
 * literally named `prompt`, and that must not be flagged.
 */
function collectBoundNames(code: string): Set<string> {
  const names = new Set<string>();
  const addList = (list: string) => {
    for (const part of list.split(',')) {
      const token = part.trim();
      if (!token) continue;
      // `a as b` / `a: b` (rename or destructure alias) binds the right-hand name.
      const alias = token.match(/(?:\bas\b|:)\s*([A-Za-z_$][\w$]*)\s*$/);
      const plain = token.match(/^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/);
      if (alias) names.add(alias[1]);
      else if (plain) names.add(plain[1]);
    }
  };

  for (const m of code.matchAll(/import\s+([^;]*?)\s+from\s/g)) addList(m[1].replace(/[{}]/g, ''));
  for (const m of code.matchAll(/\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) addList(m[1]);
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) addList(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::[^=]*)?=>/g)) addList(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

const dialogRule: Rule = {
  id: 'no-native-dialogs',
  severity: 'ADVISORY',
  title: 'native `alert` / `confirm` / `prompt` — use in-app UI instead of blocking dialogs',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    const bound = collectBoundNames(code);

    for (const name of DIALOG_NAMES) {
      // Explicit `window.alert(...)` is unambiguous — always a violation.
      for (const m of code.matchAll(new RegExp(`\\bwindow\\s*\\.\\s*${name}\\s*\\(`, 'g'))) {
        const line = lineOf(code, m.index!);
        violations.push({ file, line, message: `window.${name}() — ${lineTextAt(raw, line)}` });
      }
      if (bound.has(name)) continue; // locally bound identifier, not the native dialog

      // Bare call, not a property access (`foo.confirm(`) and not a declaration.
      for (const m of code.matchAll(new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'gm'))) {
        const line = lineOf(code, m.index!);
        violations.push({ file, line, message: `${name}() — ${lineTextAt(raw, line)}` });
      }
    }
    return violations.sort((a, b) => a.line - b.line);
  },
};

// ---------------------------------------------------------------------------
// Rule 4: marked.parse() by hand — use renderMarkdown from @bundled/marked
// ---------------------------------------------------------------------------

// `sanitizeHtml` (the SDK's single DOMPurify policy) is the expected spelling now, and
// it does not match a `\bsanitize\b` anchor — the trailing `H` is a word character, so
// the boundary never lands. Match the whole `sanitiz*` family instead.
const SANITIZER = /DOMPurify|\bsanitiz\w*|\bpurify\b|setSafeHtml|safeHtml/i;

/**
 * `renderMarkdown` from `@bundled/marked` is parse → sanitize the whole fragment →
 * rewrite links, written once; six apps hand-rolled exactly that around
 * `marked.parse()` before it existed. A `marked.parse()` call in app code is now
 * either one of those copies or a new one.
 *
 * Advisory because there is one sanctioned holdout: a render that must stay
 * unsanitized because the sanitize step sits at the app's own insertion sites
 * (word-excel's `markdownToHtml`). It says so with
 * `yaar-check-ignore render-markdown -- <reason>`.
 *
 * The message escalates when the call also reaches `innerHTML` with no sanitizer
 * within a few lines. Regex cannot prove dataflow, but that shape was a bug every
 * time it was found.
 */
const markedRule: Rule = {
  id: 'render-markdown',
  severity: 'ADVISORY',
  title: '`marked.parse()` by hand — use `renderMarkdown` from `@bundled/marked`',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    const lines = code.split('\n');
    const WINDOW = 5;

    for (const m of code.matchAll(/\bmarked\s*\.\s*parse\s*\(/g)) {
      const line = lineOf(code, m.index!);
      const from = Math.max(0, line - 1 - WINDOW);
      const to = Math.min(lines.length, line + WINDOW);
      const region = lines.slice(from, to).join('\n');
      const unsanitizedSink = /\binnerHTML\b/.test(region) && !SANITIZER.test(region);
      violations.push({
        file,
        line,
        message: unsanitizedSink
          ? `marked.parse() near innerHTML, no sanitizer within ${WINDOW} lines — ${lineTextAt(raw, line)}`
          : `marked.parse() — ${lineTextAt(raw, line)}`,
      });
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Rule 5: hand-typed command handler parameters
// ---------------------------------------------------------------------------

/**
 * `defineAppCommand()` derives the `run` parameter type from the literal JSON
 * Schema in `params`; `defineApp()` and `defineAppCommand()` do the same for
 * `run`. A hand-written annotation (`handler: (p: {...}) =>`, `run: async (p:
 * Record<string, unknown>) =>`) throws that inference away and lets the
 * annotation drift from the schema.
 *
 * ERROR since the Phase 3 sweep took it to zero. The annotation is not merely
 * redundant — it hides a lossy schema, which is what agents actually read. Every
 * case found in that sweep was a schema too weak to infer from, and fixing the
 * schema repaired the manifest as a side effect. Where a schema genuinely cannot
 * express the type (`anyOf`/`oneOf`/`$ref` infer as `unknown`), annotate and add
 * `yaar-check-ignore infer-handler-params -- <reason>`.
 */
const handlerTypeRule: Rule = {
  id: 'infer-handler-params',
  severity: 'ERROR',
  title: 'hand-typed command handler params — let the schema infer them',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    // handler: (p: X) =>  /  run: async (p: X) =>
    const re = /\b(?:handler|run)\s*:\s*(?:async\s+)?\(\s*[A-Za-z_$][\w$]*\s*:\s*/g;
    for (const m of code.matchAll(re)) {
      const line = lineOf(code, m.index!);
      const wrapped = isInsideDefineCommand(code, m.index!);
      violations.push({
        file,
        line,
        message:
          `annotated handler param${wrapped ? ' inside a define*Command()' : ''} — ` +
          lineTextAt(raw, line),
      });
    }
    return violations;
  },
};

/** True if `index` falls inside the argument list of a `define*Command(` call. */
function isInsideDefineCommand(code: string, index: number): boolean {
  for (const m of code.matchAll(/\bdefine(?:App)?Command\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    if (open > index) break;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (index > open && index < i) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule 6: narration comments
// ---------------------------------------------------------------------------

/**
 * Flags comment lines shaped like narration (`// now update the state`, `// call the
 * handler`) or task residue (`// fixed the bug where…`) — the two comment shapes the
 * authoring guide (devtools' `agent/docs/authoring-style.md`) bans, because they rot
 * the moment the change lands and are then copied as the house idiom by the next
 * generated app.
 *
 * Heuristic on purpose, and permanently ADVISORY: it matches a handful of high-confidence
 * openers on line-leading `//` comments in the raw source, and a matching line inside a
 * template literal (a scaffold that *generates* code) is worth the warning too — that
 * comment is about to be authored into another app.
 */
const NARRATION_OPENERS =
  /^\s*\/\/\s*(?:(?:now|then|first|next),?\s+(?:we|let'?s|update|call|create|render|set)\b|we\s+(?:now|then|just|need to|can now)\b|call(?:ing)?\s+the\b|fixed\s+(?:the|a)\b|as\s+requested\b|per\s+the\s+(?:request|task|fix)\b)/i;

const narrationRule: Rule = {
  id: 'narration-comment',
  severity: 'ADVISORY',
  title: 'narration or task-residue comments — comments state what the code cannot',
  scan(_code, raw, file) {
    const violations: Violation[] = [];
    for (const [i, line] of raw.split('\n').entries()) {
      if (NARRATION_OPENERS.test(line)) {
        violations.push({ file, line: i + 1, message: line.trim().slice(0, 100) });
      }
    }
    return violations;
  },
};

const RULES: Rule[] = [
  storageRule,
  sleepRule,
  dialogRule,
  markedRule,
  handlerTypeRule,
  narrationRule,
];

// ---------------------------------------------------------------------------
// Doc rule: agent/SKILL.md must not restate protocol.json
// ---------------------------------------------------------------------------

/**
 * `agent/SKILL.md` is the hand-written manual `describe('yaar://apps/{id}')` returns —
 * alongside `protocol.json`, in the same payload.
 *
 * The *previous* SKILL.md was deleted because everything it carried was either
 * `app.json`'s description or a restatement of the protocol, and a restatement is one
 * deploy away from being wrong. Returning both in one payload is what makes that
 * duplication visible and cheap to prohibit: a command name appearing in both is a
 * sentence that will disagree with the schema beside it. SKILL.md is for what a
 * generated protocol cannot say — workflows, ordering constraints, when *not* to use
 * the app.
 *
 * Advisory: a name may legitimately appear inside a workflow sentence ("run `compile`
 * before `deploy`"), which is exactly the kind of thing this file is for. The warning
 * names what was matched so the author can judge.
 */
const SKILL_DOC_RULE_ID = 'skill-restates-protocol';

function skillDocPath(appDir: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8'));
    const declared = meta?.agent?.skill;
    if (typeof declared === 'string' && declared && !declared.startsWith('/')) return declared;
  } catch {
    /* no app.json, or unreadable — the default is the answer */
  }
  return 'agent/SKILL.md';
}

function scanSkillDoc(appDir: string, appId: string): Violation[] {
  let skill: string;
  try {
    skill = readFileSync(join(appDir, skillDocPath(appDir)), 'utf8');
  } catch {
    return []; // No SKILL.md — the common case.
  }

  let protocol: { state?: Record<string, unknown>; commands?: Record<string, unknown> };
  try {
    protocol = JSON.parse(readFileSync(join(appDir, 'dist', 'protocol.json'), 'utf8'));
  } catch {
    return []; // Nothing compiled to compare against.
  }

  const names = [...Object.keys(protocol.state ?? {}), ...Object.keys(protocol.commands ?? {})];
  const lines = skill.split('\n');
  const violations: Violation[] = [];
  const file = relative(REPO_ROOT, join(appDir, skillDocPath(appDir)));

  // A heading or a bullet whose subject *is* the name is the restatement shape —
  // "### searchMemos" or "- `searchMemos` — full-text search". A name mentioned mid
  // sentence is prose, and prose is the point of the file.
  for (const [i, line] of lines.entries()) {
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^\\s*(#{1,6}\\s*|[-*]\\s+)\`?${escaped}\`?\\s*(\\(|—|-|:|$)`).test(line)) {
        violations.push({
          file,
          line: i + 1,
          message:
            `"${name}" is already in ${appId}'s protocol.json — describe returns both, so this ` +
            'entry is a copy that will go stale. Keep SKILL.md for what the protocol cannot say.',
        });
        break;
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Doc rules: the agent/docs/ topic tier
// ---------------------------------------------------------------------------

/**
 * `agent/docs/*.md` is the pull tier of app knowledge: one topic per file, indexed by
 * its frontmatter `description` into every generated index (the app agent's prompt
 * appendix, describe payloads, `yaar://apps/{id}/docs`). The index is the entire
 * static-tier footprint of a topic — a pull-based doc is only reachable if the index
 * says it exists — so the frontmatter is validated hard (`app-doc-frontmatter`, ERROR:
 * the tier is new, so the count starts at zero and stays there), and two advisory rules
 * keep the tier honest over time:
 *
 * - `prompt-restates-topic` — a `prompt.md` heading matching a topic's name is the
 *   restatement smell: the section was migrated to the docs tier and then grew back.
 *   Same detection shape as `skill-restates-protocol`, and advisory for the same
 *   reason — a heading can legitimately share words with a topic.
 * - `doc-may-be-stale` — a `covers` path newer (by mtime) than its topic file. Warn,
 *   not fail: a source change may not touch what the doc describes; authors confirm
 *   by touching (or editing) the doc.
 */
const DOC_FRONTMATTER_RULE_ID = 'app-doc-frontmatter';
const PROMPT_TOPIC_RULE_ID = 'prompt-restates-topic';
const DOC_STALE_RULE_ID = 'doc-may-be-stale';

function agentPromptPath(appDir: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8'));
    const declared = meta?.agent?.prompt;
    if (typeof declared === 'string' && declared && !declared.startsWith('/')) return declared;
  } catch {
    /* no app.json, or unreadable — the default is the answer */
  }
  return 'agent/prompt.md';
}

interface AppDocScan {
  frontmatter: Violation[];
  restates: Violation[];
  stale: Violation[];
}

/** A heading reduced to the shape a slug has, so the two can be compared at all. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scanAppDocs(appDir: string, appId: string): AppDocScan {
  const result: AppDocScan = { frontmatter: [], restates: [], stale: [] };
  const docsDir = join(appDir, AGENT_DOCS_DIR);

  let entries: string[];
  try {
    entries = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return result; // No agent/docs/ — the common case.
  }

  const topicNames: string[] = [];
  for (const filename of entries.sort()) {
    const file = relative(REPO_ROOT, join(docsDir, filename));
    const bad = (message: string) => result.frontmatter.push({ file, line: 1, message });

    const stem = filename.replace(/\.md$/, '');
    if (!DOC_SLUG_RE.test(stem)) {
      bad(`"${filename}" is not a kebab-case slug — the topic is unaddressable.`);
      continue;
    }
    topicNames.push(stem);

    const content = readFileSync(join(docsDir, filename), 'utf8');
    const { fields } = parseDocFrontmatter(content);

    if (typeof fields.name === 'string' && fields.name !== stem) {
      bad(`frontmatter name "${fields.name}" disagrees with the filename — the filename wins.`);
    }
    if (typeof fields.description !== 'string' || !fields.description) {
      bad(
        'missing frontmatter description — the description is the topic’s entire ' +
          'always-loaded footprint; write it as the trigger ("read before touching X").',
      );
    } else if (fields.description.length > DOC_DESCRIPTION_MAX) {
      bad(
        `description is ${fields.description.length} chars (max ${DOC_DESCRIPTION_MAX}) — ` +
          'past that length it is a summary, not a trigger.',
      );
    }
    if (
      fields.audience !== undefined &&
      !(
        typeof fields.audience === 'string' &&
        (DOC_AUDIENCES as readonly string[]).includes(fields.audience)
      )
    ) {
      bad(`audience must be one of ${DOC_AUDIENCES.join('/')}.`);
    }

    const covers = Array.isArray(fields.covers)
      ? fields.covers
      : typeof fields.covers === 'string' && fields.covers
        ? [fields.covers]
        : [];
    const docMtime = statSync(join(docsDir, filename)).mtimeMs;
    for (const pattern of covers) {
      const matches = [...new Bun.Glob(pattern).scanSync({ cwd: appDir })];
      if (matches.length === 0) {
        bad(`covers "${pattern}" matches nothing under apps/${appId}/ — a broken pointer.`);
        continue;
      }
      const newer = matches.filter((m) => {
        try {
          return statSync(join(appDir, m)).mtimeMs > docMtime;
        } catch {
          return false;
        }
      });
      if (newer.length > 0) {
        result.stale.push({
          file,
          line: 1,
          message:
            `${newer.slice(0, 3).join(', ')}${newer.length > 3 ? `, … (${newer.length} total)` : ''} ` +
            'changed after this topic was last written — confirm the doc still holds, then touch it.',
        });
      }
    }
  }

  // The restatement lint: a prompt heading whose slugified form is a topic's name.
  if (topicNames.length > 0) {
    const promptRel = agentPromptPath(appDir);
    let prompt: string;
    try {
      prompt = readFileSync(join(appDir, promptRel), 'utf8');
    } catch {
      return result; // No prompt.md — the generic base restates nothing.
    }
    const file = relative(REPO_ROOT, join(appDir, promptRel));
    for (const [i, line] of prompt.split('\n').entries()) {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (!heading) continue;
      const slug = slugify(heading[1]);
      const hit = topicNames.find((t) => slug === t);
      if (hit) {
        result.restates.push({
          file,
          line: i + 1,
          message:
            `heading matches the "${hit}" topic in ${AGENT_DOCS_DIR}/ — the prompt must carry ` +
            'the index line, not the section. Keep bright lines; move the prose.',
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Authoring rules: shared chrome and protocol descriptions
// ---------------------------------------------------------------------------

/**
 * Two more per-app-surface rules from the authoring guide
 * (`apps/devtools/agent/docs/authoring-style.md`), both ADVISORY:
 *
 * - `local-chrome-shadow` — app CSS redefining a `.y-*` chrome class or assigning a
 *   `--yaar-*` design token. The platform injects both into every app; a local
 *   redefinition shadows the shared copy, and the next clone copies the shadow — the
 *   drift the app-UI-pattern work already paid to undo once. *Using* a class in markup
 *   is the point; *redefining* it in a stylesheet is the smell.
 * - `local-chrome-clone` — an app rule block that restates a `y-*` chrome block under
 *   its own name (`.tbar` that is `.y-toolbar` declaration for declaration). The shadow
 *   rule above cannot see this: nothing is *redefined*, the copy just exists — which is
 *   how eleven apps came to carry their own toolbar, status bar, modal and empty state.
 *   The fix is to add the `y-*` class and keep only the deltas as the local rule.
 * - `protocol-description-shape` — a command description that is missing, opens with
 *   name-restating boilerplate ("this command…", "allows the agent to…"), or runs to
 *   multiple paragraphs. Descriptions are prompt material read by an agent deciding
 *   whether to call the command; the shape is one line — what it does, then the
 *   precondition that makes it fail.
 */
const CHROME_SHADOW_RULE_ID = 'local-chrome-shadow';
const CHROME_CLONE_RULE_ID = 'local-chrome-clone';
const PROTOCOL_DESCRIPTION_RULE_ID = 'protocol-description-shape';

function cssFilesUnder(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFilesUnder(full, acc);
    else if (entry.endsWith('.css')) acc.push(full);
  }
  return acc;
}

function scanChromeShadow(appDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const cssPath of cssFilesUnder(join(appDir, 'src'))) {
    const file = relative(REPO_ROOT, cssPath);
    const lines = readFileSync(cssPath, 'utf8').split('\n');
    // Same suppression contract as the source rules: `yaar-check-ignore
    // local-chrome-shadow -- <reason>` in a CSS comment on the line or the line above.
    const suppressed = (i: number) =>
      [lines[i], lines[i - 1]].some(
        (l) => l != null && /yaar-check-ignore\s+local-chrome-shadow\s+--\s+\S/.test(l),
      );
    for (const [i, line] of lines.entries()) {
      if (suppressed(i)) continue;
      // A *bare* `.y-*` selector — the line's selector starts with the chrome class —
      // redefines it for the whole app. A scoped override (`.account-controls .y-btn
      // { margin-left: auto }`) is laying out an instance inside a local container and
      // passes; restyling through a scope is possible but rare, and this is warn-tier.
      // `var(--yaar-…)` *usage* is fine anywhere; assignment is not.
      if (/^\s*\.y-[a-z0-9-]+[^;{}]*[{,]/.test(line)) {
        violations.push({
          file,
          line: i + 1,
          message: `redefines shared chrome: ${line.trim().slice(0, 80)} — the y-* classes are platform-injected; style your own class instead.`,
        });
      } else if (/--yaar-[a-z0-9-]+\s*:/.test(line)) {
        violations.push({
          file,
          line: i + 1,
          message: `assigns a design token: ${line.trim().slice(0, 80)} — --yaar-* values are the platform's; define an app-local property instead.`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// local-chrome-clone: a rule block that restates a y-* block
// ---------------------------------------------------------------------------

/**
 * A local block is a clone when (a) at least `CLONE_MIN_SHARED` of its declarations
 * are identical to one y-* block's, (b) those cover at least `CLONE_MIN_FRACTION` of
 * that chrome block, and (c) at least `CLONE_MIN_DISTINCTIVE` of them are the kind
 * of declaration that makes chrome chrome — a surface, an edge, padding, a shadow —
 * rather than the `display/align-items/gap` every flex row shares.
 *
 * Each threshold answers a false positive from the first run over `apps/`: without
 * (b) any bordered box "restated" `.y-input` and any padded row `.y-btn`; without
 * (c) a muted 12px label with a cursor "restated" `.y-tbtn`. With all three, the
 * eleven-app sweep of 2026-09 fires on every copy in its table and stays quiet on
 * the deliberate variants (a card-shaped empty state, an absolutely positioned
 * toolbar, an anchored popover).
 */
const CLONE_MIN_SHARED = 4;
const CLONE_MIN_FRACTION = 0.5;
const CLONE_MIN_DISTINCTIVE = 2;
const CLONE_DISTINCTIVE_PROPS = new Set([
  'background',
  'background-color',
  'border',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'border-radius',
  'padding',
  'box-shadow',
  'z-index',
  'animation',
  'transform',
  'backdrop-filter',
  'text-overflow',
  '-webkit-line-clamp',
  '-webkit-box-orient',
  'scrollbar-width',
  'scrollbar-color',
  'letter-spacing',
  'text-transform',
]);

interface CssBlock {
  selector: string;
  /** Normalised `prop → value`; custom properties and nested blocks are dropped. */
  decls: Map<string, string>;
  /** 1-based line of the selector in the source. */
  line: number;
}

/** Comments become spaces (newlines kept) so block line numbers survive. */
function blankCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The length tokens, so `padding: 8px 12px` and `padding: var(--yaar-sp-2)
 * var(--yaar-sp-3)` compare equal. Colours are not resolved: an app that writes
 * the hex of a colour token is a token-guard concern, not a chrome one.
 */
const LENGTH_TOKENS: ReadonlyMap<string, string> = (() => {
  const root = YAAR_APP_TOKENS_CSS.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const m of root.matchAll(/(--yaar-[a-z0-9-]+)\s*:\s*(-?\d+(?:\.\d+)?px)\s*;/g)) {
    out.set(m[1], m[2]);
  }
  return out;
})();

function normalizeCssValue(raw: string): string {
  let v = raw
    .toLowerCase()
    .replace(/!important/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  v = v.replace(/var\(\s*(--yaar-[a-z0-9-]+)\s*\)/g, (m, name) => LENGTH_TOKENS.get(name) ?? m);
  return v
    .replace(/\s*([(),:])\s*/g, '$1')
    .replace(/(^|[^\d.])0+\.(\d)/g, '$1.$2')
    .replace(/(^|[^\d.])0(px|em|rem|%)/g, '$10');
}

/**
 * Flat rule blocks, descending into block at-rules (`@media`, `@supports`, …) and
 * skipping `@keyframes` bodies. A nested-CSS body (braces inside a rule) is skipped
 * whole — it is rare in app CSS and never worth a false positive.
 */
function parseCssBlocks(css: string): CssBlock[] {
  const src = blankCssComments(css);
  const blocks: CssBlock[] = [];
  const lineAt = (index: number) => src.slice(0, index).split('\n').length;

  const walk = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const open = src.indexOf('{', i);
      if (open === -1 || open >= to) return;
      const selector = src.slice(i, open).trim();
      // Find the matching close brace for this block.
      let depth = 1;
      let j = open + 1;
      while (j < to && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const bodyStart = open + 1;
      const bodyEnd = j - 1;
      if (selector.startsWith('@')) {
        if (
          !/^@(keyframes|-webkit-keyframes|font-face|page|counter-style|property)\b/.test(selector)
        ) {
          walk(bodyStart, bodyEnd);
        }
      } else if (src.slice(bodyStart, bodyEnd).includes('{')) {
        // Nested CSS: skip.
      } else if (selector) {
        const decls = new Map<string, string>();
        for (const decl of src.slice(bodyStart, bodyEnd).split(';')) {
          const colon = decl.indexOf(':');
          if (colon === -1) continue;
          const prop = decl.slice(0, colon).trim().toLowerCase();
          if (!prop || prop.startsWith('--')) continue;
          decls.set(prop, normalizeCssValue(decl.slice(colon + 1)));
        }
        blocks.push({
          selector: selector.replace(/\s+/g, ' '),
          decls,
          line: lineAt(src.indexOf(selector, i)),
        });
      }
      i = j;
    }
  };
  walk(0, src.length);
  return blocks;
}

/** The y-* chrome blocks, keyed by class — bare single-class selectors only. */
const CHROME_BLOCKS: ReadonlyMap<string, Map<string, string>> = (() => {
  const out = new Map<string, Map<string, string>>();
  for (const block of parseCssBlocks(YAAR_APP_TOKENS_CSS)) {
    const m = block.selector.match(/^\.(y-[a-z0-9-]+)$/);
    if (!m || block.decls.size < CLONE_MIN_SHARED) continue;
    // Two families are not authoring targets for a lone block: the y-nav-* classes
    // are one widget (the hover-open panel state machine) and only mean anything
    // together — every quiet icon button "restates" y-nav-pin otherwise — and the
    // y-toast* classes are written by showToast(), never by hand.
    if (/^y-(nav|toast)\b/.test(m[1])) continue;
    // A class packed onto one line with others is parsed as several blocks; the
    // last definition wins, matching the cascade.
    out.set(m[1], block.decls);
  }
  return out;
})();

function scanChromeClones(appDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const cssPath of cssFilesUnder(join(appDir, 'src'))) {
    const file = relative(REPO_ROOT, cssPath);
    const raw = readFileSync(cssPath, 'utf8');
    const lines = raw.split('\n');
    const suppressed = (line: number) =>
      [lines[line - 1], lines[line - 2]].some(
        (l) => l != null && /yaar-check-ignore\s+local-chrome-clone\s+--\s+\S/.test(l),
      );
    for (const block of parseCssBlocks(raw)) {
      // Anything already layered on the chrome (`.tbar.y-toolbar`, `.y-modal .y-input`)
      // is an override, not a copy; element and root selectors are resets.
      if (block.selector.includes('.y-') || /^(:root|html|body|\*)\b/.test(block.selector))
        continue;
      if (block.decls.size < CLONE_MIN_SHARED || suppressed(block.line)) continue;
      let best: { name: string; shared: number; distinctive: number } | null = null;
      const isColumn = block.decls.get('flex-direction') === 'column';
      for (const [name, chrome] of CHROME_BLOCKS) {
        // A column stack is never a copy of a row, however many edges they share.
        if (isColumn && chrome.has('display') && !chrome.has('flex-direction')) continue;
        let shared = 0;
        let distinctive = 0;
        for (const [prop, value] of block.decls) {
          if (chrome.get(prop) !== value) continue;
          shared++;
          if (CLONE_DISTINCTIVE_PROPS.has(prop)) distinctive++;
        }
        if (
          shared < CLONE_MIN_SHARED ||
          shared < chrome.size * CLONE_MIN_FRACTION ||
          distinctive < CLONE_MIN_DISTINCTIVE
        )
          continue;
        if (
          !best ||
          shared > best.shared ||
          (shared === best.shared && distinctive > best.distinctive)
        ) {
          best = { name, shared, distinctive };
        }
      }
      if (best) {
        violations.push({
          file,
          line: block.line,
          message: `${block.selector} restates ${best.name} (${best.shared} shared declarations) — add the class to the markup and keep only the deltas here.`,
        });
      }
    }
  }
  return violations;
}

const DESCRIPTION_BOILERPLATE =
  /^(this (command|state key|key)\b|allows? (the agent|you|an agent)\b|(is )?used (to|for)\b)/i;

function scanProtocolDescriptions(appDir: string, appId: string): Violation[] {
  let protocol: { commands?: Record<string, unknown> };
  try {
    protocol = JSON.parse(readFileSync(join(appDir, 'dist', 'protocol.json'), 'utf8'));
  } catch {
    return []; // Nothing compiled to check.
  }

  const file = relative(REPO_ROOT, join(appDir, 'dist', 'protocol.json'));
  const violations: Violation[] = [];
  for (const [name, entry] of Object.entries(protocol.commands ?? {})) {
    const description =
      typeof entry === 'string' ? entry : ((entry as { description?: string })?.description ?? '');
    const bad = (why: string) =>
      violations.push({
        file,
        line: 1,
        message: `${appId}: command "${name}" ${why} — fix the descriptor in src/ and recompile; dist/ is generated.`,
      });

    if (!description.trim()) {
      bad('has no description; an agent cannot decide whether to call it');
    } else if (DESCRIPTION_BOILERPLATE.test(description.trim())) {
      bad(
        `opens with boilerplate ("${description.trim().slice(0, 40)}…"); lead with the effect, then the failure precondition`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
}

/** Every source file under `apps/*​/src`, or under the explicitly named targets. */
function collectFiles(targets: string[]): string[] {
  if (targets.length > 0) {
    const files: string[] = [];
    for (const target of targets) {
      const abs = resolve(REPO_ROOT, target);
      if (statSync(abs).isDirectory()) walk(abs, files);
      else files.push(abs);
    }
    return files.sort();
  }

  const files: string[] = [];
  for (const app of readdirSync(APPS_DIR)) {
    const src = join(APPS_DIR, app, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src, files);
    } catch {
      /* app folder without src/ — nothing to scan */
    }
  }
  return files.sort();
}

/**
 * A violation is suppressed by `yaar-check-ignore <rule-id> -- <reason>` on the
 * offending line or the line above it. A reason is required: these rules have
 * genuine exceptions (a schema using `anyOf`/`oneOf`/`$ref` infers as `unknown`,
 * so annotating that handler's parameter is sanctioned — see `YaarInferSchema`),
 * and an escape hatch is what lets such a rule be an ERROR rather than a warning
 * everyone learns to scroll past. Silent blanket-ignores are not accepted.
 */
function isSuppressed(rawLines: string[], v: Violation, ruleId: string): boolean {
  const marker = new RegExp(
    `yaar-check-ignore\\s+${ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+--\\s+\\S`,
  );
  return [rawLines[v.line - 1], rawLines[v.line - 2]].some((l) => l != null && marker.test(l));
}

/**
 * The app directories the per-app rules run over: every `apps/*` folder, narrowed to
 * the named targets — plus any target that is itself an app folder *outside* `apps/`
 * (a `user-apps/<id>`, a workspace clone). Those are git-ignored and never scanned by
 * default, but the CSS rules are calibrated against them, so
 * `bun run check:apps user-apps/mesh-edit` has to work.
 */
function appDirsFor(targets: string[]): string[] {
  const dirs: string[] = [];
  for (const app of readdirSync(APPS_DIR)) {
    const appDir = join(APPS_DIR, app);
    try {
      if (!statSync(appDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (targets.length > 0 && !targets.some((t) => resolve(REPO_ROOT, t).startsWith(appDir)))
      continue;
    dirs.push(appDir);
  }
  for (const target of targets) {
    const abs = resolve(REPO_ROOT, target);
    if (abs.startsWith(APPS_DIR)) continue;
    try {
      if (statSync(abs).isDirectory() && statSync(join(abs, 'src')).isDirectory()) dirs.push(abs);
    } catch {
      /* not an app folder — the source rules still scan it as files */
    }
  }
  return dirs;
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const quiet = rawArgs.includes('--quiet');
  const strict = rawArgs.includes('--strict');
  const targets = rawArgs.filter((a) => !a.startsWith('--'));

  const files = collectFiles(targets);
  const byRule = new Map<string, Violation[]>(RULES.map((r) => [r.id, []]));

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const code = stripCommentsAndStrings(raw);
    const rel = relative(REPO_ROOT, file);
    const rawLines = raw.split('\n');
    for (const rule of RULES) {
      byRule
        .get(rule.id)!
        .push(...rule.scan(code, raw, rel).filter((v) => !isSuppressed(rawLines, v, rule.id)));
    }
  }

  // Doc rules run per app directory, not per source file — they compare artifacts
  // (agent/SKILL.md, agent/docs/*.md, agent/prompt.md, dist/protocol.json), none of
  // which is scannable source.
  const skillViolations: Violation[] = [];
  const docScan: AppDocScan = { frontmatter: [], restates: [], stale: [] };
  const chromeViolations: Violation[] = [];
  const cloneViolations: Violation[] = [];
  const descriptionViolations: Violation[] = [];
  for (const appDir of appDirsFor(targets)) {
    const app = basename(appDir);
    skillViolations.push(...scanSkillDoc(appDir, app));
    const scan = scanAppDocs(appDir, app);
    docScan.frontmatter.push(...scan.frontmatter);
    docScan.restates.push(...scan.restates);
    docScan.stale.push(...scan.stale);
    chromeViolations.push(...scanChromeShadow(appDir));
    cloneViolations.push(...scanChromeClones(appDir));
    descriptionViolations.push(...scanProtocolDescriptions(appDir, app));
  }

  const docRules: Array<{ id: string; severity: Severity; title: string; found: Violation[] }> = [
    {
      id: SKILL_DOC_RULE_ID,
      severity: 'ADVISORY',
      title: 'agent/SKILL.md does not restate protocol.json',
      found: skillViolations,
    },
    {
      id: DOC_FRONTMATTER_RULE_ID,
      severity: 'ERROR',
      title: 'agent/docs/ topics carry valid frontmatter',
      found: docScan.frontmatter,
    },
    {
      id: PROMPT_TOPIC_RULE_ID,
      severity: 'ADVISORY',
      title: 'agent/prompt.md does not restate a docs topic',
      found: docScan.restates,
    },
    {
      id: DOC_STALE_RULE_ID,
      severity: 'ADVISORY',
      title: 'agent/docs/ topics are newer than the sources they cover',
      found: docScan.stale,
    },
    {
      id: CHROME_SHADOW_RULE_ID,
      severity: 'ADVISORY',
      title: 'app CSS does not redefine y-* chrome or assign --yaar-* tokens',
      found: chromeViolations,
    },
    {
      id: CHROME_CLONE_RULE_ID,
      severity: 'ADVISORY',
      title: 'app CSS does not restate a y-* chrome block under its own name',
      found: cloneViolations,
    },
    {
      id: PROTOCOL_DESCRIPTION_RULE_ID,
      severity: 'ADVISORY',
      title: 'protocol command descriptions lead with the effect, not boilerplate',
      found: descriptionViolations,
    },
  ];

  let errorTotal = 0;
  let advisoryTotal = 0;

  for (const rule of docRules) {
    if (rule.severity === 'ERROR') errorTotal += rule.found.length;
    else advisoryTotal += rule.found.length;

    if (rule.found.length === 0) {
      if (!quiet) console.log(`✅ [${rule.severity}] ${rule.id}: clean — ${rule.title}`);
      continue;
    }
    const icon = rule.severity === 'ERROR' ? '❌' : '⚠️ ';
    const log = rule.severity === 'ERROR' ? console.error : console.warn;
    log(`${icon} [${rule.severity}] ${rule.id}: ${rule.found.length} violation(s) — ${rule.title}`);
    for (const v of rule.found) log(`     ${v.file}:${v.line}  ${v.message}`);
  }

  for (const rule of RULES) {
    const found = byRule.get(rule.id)!;
    if (rule.severity === 'ERROR') errorTotal += found.length;
    else advisoryTotal += found.length;

    if (found.length === 0) {
      if (!quiet) console.log(`✅ [${rule.severity}] ${rule.id}: clean — ${rule.title}`);
      continue;
    }
    const icon = rule.severity === 'ERROR' ? '❌' : '⚠️ ';
    const log = rule.severity === 'ERROR' ? console.error : console.warn;
    log(`${icon} [${rule.severity}] ${rule.id}: ${found.length} violation(s) — ${rule.title}`);
    for (const v of found) log(`     ${v.file}:${v.line}  ${v.message}`);
  }

  console.log(`\nScanned ${files.length} file(s) under apps/*/src.`);
  console.log('Per-rule violation counts (a rule at 0 is ready to promote to ERROR):');
  for (const rule of RULES) {
    console.log(
      `  ${rule.severity.padEnd(8)} ${rule.id.padEnd(24)} ${byRule.get(rule.id)!.length}`,
    );
  }
  for (const rule of docRules) {
    console.log(`  ${rule.severity.padEnd(8)} ${rule.id.padEnd(24)} ${rule.found.length}`);
  }

  if (errorTotal > 0) {
    console.error(
      `\n${errorTotal} hard violation(s). These rules were promoted to ERROR after their ` +
        `count reached zero — a non-zero count means a migration regressed. Fix the code; ` +
        `do not downgrade the rule.`,
    );
    process.exit(1);
  }
  if (strict && advisoryTotal > 0) {
    console.error(`\n${advisoryTotal} advisory violation(s); --strict treats these as failures.`);
    process.exit(1);
  }
  if (advisoryTotal > 0) {
    console.log(`\nNo hard violations (${advisoryTotal} advisory warning(s) above).`);
  } else if (!quiet) {
    console.log('\nAll app guardrails clean.');
  }
}

main();
