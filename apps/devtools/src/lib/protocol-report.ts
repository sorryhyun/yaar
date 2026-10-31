export {};

// Reads over the compiled protocol (`dist/protocol.json`): what it costs a reader, and
// whether the docs still name what it declares. Lexical on the docs side, so a finding is
// a place to look, not a verdict.

export interface ProtocolEntry {
  description?: string;
  params?: unknown;
}

export interface ProtocolDoc {
  commands?: Record<string, ProtocolEntry>;
  state?: Record<string, ProtocolEntry>;
}

export interface ProtocolSizeReport {
  commands: number;
  state: number;
  /** Serialized chars of every description and params schema. */
  totalChars: number;
  descriptionChars: number;
  /** Per `group/` prefix, largest first; only for a grouped protocol. */
  groups?: { group: string; commands: number; chars: number }[];
  /** The heaviest entries, largest first. */
  largest: { name: string; chars: number; descriptionChars: number }[];
}

const LARGEST_LISTED = 10;

const entryChars = (entry: ProtocolEntry): number =>
  (entry.description?.length ?? 0) +
  (entry.params === undefined ? 0 : JSON.stringify(entry.params).length);

export function protocolSizeReport(protocol: ProtocolDoc): ProtocolSizeReport {
  const commands = Object.entries(protocol.commands ?? {});
  const state = Object.entries(protocol.state ?? {});
  const rows = [...commands, ...state].map(([name, entry]) => ({
    name,
    chars: entryChars(entry),
    descriptionChars: entry.description?.length ?? 0,
  }));
  const groups = new Map<string, { commands: number; chars: number }>();
  for (const [name, entry] of commands) {
    const at = name.indexOf('/');
    if (at <= 0) continue;
    const group = name.slice(0, at);
    const row = groups.get(group) ?? { commands: 0, chars: 0 };
    row.commands++;
    row.chars += entryChars(entry);
    groups.set(group, row);
  }
  return {
    commands: commands.length,
    state: state.length,
    totalChars: rows.reduce((n, r) => n + r.chars, 0),
    descriptionChars: rows.reduce((n, r) => n + r.descriptionChars, 0),
    ...(groups.size > 0
      ? {
          groups: [...groups]
            .map(([group, row]) => ({ group, ...row }))
            .sort((a, b) => b.chars - a.chars),
        }
      : {}),
    largest: rows.sort((a, b) => b.chars - a.chars).slice(0, LARGEST_LISTED),
  };
}

export interface DocMention {
  file: string;
  line: number;
  mention: string;
  problem: string;
}

/** Top-level keys of the `{ … }` that opens at `start`, or null when it cannot be read. */
function objectKeys(text: string, start: number): string[] | null {
  const keys: string[] = [];
  let depth = 0;
  let quote = '';
  let expectKey = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return keys;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ',') {
      expectKey = true;
      continue;
    }
    if (!expectKey || /\s/.test(ch)) continue;
    const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64));
    if (!key) return null;
    keys.push(key[0]);
    i += key[0].length - 1;
    expectKey = false;
  }
  return null;
}

const paramNames = (entry: ProtocolEntry | undefined): Set<string> | null => {
  const props = (entry?.params as { properties?: unknown } | undefined)?.properties;
  return props && typeof props === 'object' ? new Set(Object.keys(props)) : null;
};

/** A name that stands for whatever command the example is about. */
const PLACEHOLDER = /^(?:name|command|x|foo|bar|\.\.\.|…)$/;

/**
 * Commands, state keys and call params the docs name that the protocol does not declare.
 * Recognised forms: `group/name`, `group/name({ a, b })`, `command({ command: "x", params: { a } })`
 * and `query("x")`. A call that carries `appId` is about another app and is left alone, as are
 * `group/…` paths in a group the protocol does not have and `storage:*` built-ins.
 */
export function checkDocMentions(
  docs: { path: string; text: string }[],
  protocol: ProtocolDoc,
): DocMention[] {
  const commands = protocol.commands ?? {};
  const state = protocol.state ?? {};
  const names = Object.keys(commands);
  const groups = [...new Set(names.filter((n) => n.includes('/')).map((n) => n.split('/')[0]))];
  const grouped =
    groups.length > 0
      ? new RegExp(
          `(?<![\\w/.:-])(?:${groups.join('|')})\\/[A-Za-z][\\w-]*(?![\\w/-]|\\.[A-Za-z])`,
          'g',
        )
      : null;
  const commandCall = /\bcommand\(\s*\{?\s*(?:command:\s*)?["']([^"']+)["']([^\n]*)/g;
  const stateRead = /\bquery\(\s*\{?\s*(?:stateKey:\s*)?["']([^"']+)["']([^\n]*)/g;

  const out: DocMention[] = [];
  for (const { path, text } of docs) {
    const seen = new Set<string>();
    const report = (line: number, mention: string, problem: string) => {
      const key = `${mention}\u0000${problem}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ file: path, line, mention, problem });
    };
    const checkParams = (line: number, name: string, body: string, at: number) => {
      const declared = paramNames(commands[name]);
      const keys = declared ? objectKeys(body, at) : null;
      if (!declared || !keys) return;
      for (const key of keys) {
        if (!declared.has(key))
          report(line, `${name} ${key}`, `${name} declares no param "${key}"`);
      }
    };
    text.split('\n').forEach((raw, index) => {
      const line = index + 1;
      for (const m of raw.matchAll(commandCall)) {
        const [, name, tail] = m;
        if (/\bappId\b/.test(tail) || name.includes(':') || PLACEHOLDER.test(name)) continue;
        if (!commands[name]) {
          report(line, name, 'no such command');
          continue;
        }
        const params = /\bparams:\s*\{/.exec(tail);
        if (params) {
          checkParams(line, name, tail, params.index + params[0].length - 1);
        } else {
          const inline = /^\s*,\s*\{/.exec(tail);
          if (inline) checkParams(line, name, tail, inline[0].length - 1);
        }
      }
      for (const m of raw.matchAll(stateRead)) {
        const [, key, tail] = m;
        if (/\bappId\b/.test(tail) || PLACEHOLDER.test(key)) continue;
        if (key.startsWith('__') || key === 'manifest' || /[/:]/.test(key)) continue;
        if (!state[key]) report(line, key, 'no such state key');
      }
      if (!grouped) return;
      for (const m of raw.matchAll(grouped)) {
        const name = m[0];
        if (!commands[name]) {
          report(line, name, 'no such command');
          continue;
        }
        const call = raw.slice(m.index + name.length);
        if (call.startsWith('({')) checkParams(line, name, call, 1);
      }
    });
  }
  return out;
}
