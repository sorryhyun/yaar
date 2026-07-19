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
 *   bun run scripts/check-apps.ts             # scan every app
 *   bun run scripts/check-apps.ts apps/memo   # scan specific apps or files
 *   bun run scripts/check-apps.ts --quiet     # only print violations
 *   bun run scripts/check-apps.ts --strict    # fail on advisory rules too
 *
 * Exit code: 1 if any ERROR rule has violations (or any rule, under --strict).
 *
 * Source text is comment- and string-stripped (with offsets preserved) before
 * matching, so a `javascript:alert(1)` inside a comment or a string literal is
 * not mistaken for a real native-dialog call.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
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
// Rule 4: marked.parse() reaching innerHTML without an adjacent sanitizer
// ---------------------------------------------------------------------------

const SANITIZER = /DOMPurify|\bsanitize\b|\bpurify\b|setSafeHtml|safeHtml/i;

/**
 * Advisory by design: regex cannot prove dataflow from `marked.parse()` to an
 * `innerHTML` sink. Heuristic — a `marked.parse()` call with an `innerHTML`
 * write within a few lines and no sanitizer mentioned nearby.
 */
const markedRule: Rule = {
  id: 'marked-to-innerhtml',
  severity: 'ADVISORY',
  title: '`marked.parse()` reaching `innerHTML` with no adjacent sanitizer (DOMPurify)',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    const lines = code.split('\n');
    const WINDOW = 5;

    for (const m of code.matchAll(/\bmarked\s*\.\s*parse\s*\(/g)) {
      const line = lineOf(code, m.index!);
      const from = Math.max(0, line - 1 - WINDOW);
      const to = Math.min(lines.length, line + WINDOW);
      const region = lines.slice(from, to).join('\n');
      if (!/\binnerHTML\b/.test(region)) continue;
      if (SANITIZER.test(region)) continue;
      violations.push({
        file,
        line,
        message: `marked.parse() near innerHTML, no sanitizer within ${WINDOW} lines — ${lineTextAt(raw, line)}`,
      });
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Rule 5: hand-typed command handler parameters
// ---------------------------------------------------------------------------

/**
 * `defineCommand()` derives the handler parameter type from the literal JSON
 * Schema in `params`. A hand-written annotation (`handler: (p: {...}) =>` or
 * `handler: async (p: Record<string, unknown>) =>`) throws that inference away
 * and lets the annotation drift from the schema.
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
  title: 'hand-typed command handler params — let `defineCommand` infer from the schema',
  scan(code, raw, file) {
    const violations: Violation[] = [];
    // handler: (p: X) =>   /   handler: async (p: X) =>
    const re = /\bhandler\s*:\s*(?:async\s+)?\(\s*[A-Za-z_$][\w$]*\s*:\s*/g;
    for (const m of code.matchAll(re)) {
      const line = lineOf(code, m.index!);
      const wrapped = isInsideDefineCommand(code, m.index!);
      violations.push({
        file,
        line,
        message:
          `annotated handler param${wrapped ? ' inside defineCommand()' : ''} — ` +
          lineTextAt(raw, line),
      });
    }
    return violations;
  },
};

/** True if `index` falls inside the argument list of some `defineCommand(` call. */
function isInsideDefineCommand(code: string, index: number): boolean {
  for (const m of code.matchAll(/\bdefineCommand\s*\(/g)) {
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

const RULES: Rule[] = [storageRule, sleepRule, dialogRule, markedRule, handlerTypeRule];

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

  let errorTotal = 0;
  let advisoryTotal = 0;

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
