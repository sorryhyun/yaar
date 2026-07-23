/**
 * Regenerate src/charset.ts from the models' own configs.
 *
 *   bun run apps/ocr/scripts/gen-charset.ts
 *
 * PaddleOCR ships the CTC label set inside `inference.yml` as
 * `PostProcess.character_dict`. The exported graph's output width is two larger
 * than that list, because `CTCLabelDecode` builds its label table as
 * `['blank'] + character_dict + [' ']` (blank first, space appended because
 * `use_space_char` is on). Those two extra slots are the whole reason this file
 * exists rather than the dictionary being read at runtime: the mapping is a
 * property of the decoder, not of the file, and getting it off by one silently
 * produces plausible-looking garbage.
 *
 * The v6 sizes do NOT all share a dictionary. `medium` and `small` use the
 * 50-language set; `tiny` uses a much smaller one. Feeding a model the wrong
 * table decodes to fluent-looking nonsense rather than failing, so each dictionary
 * is emitted separately and `model.ts` pins one per model — with a runtime check
 * that the model's output width matches.
 *
 * Entries are all single characters, so each dictionary is stored as one string.
 * Many are astral (emoji, rare CJK ext-B), so consumers must split with
 * `Array.from` — a `.length`/`[i]` walk would tear surrogate pairs.
 *
 * The YAML subset here is deliberately hand-parsed: every value is a lone scalar
 * on its own `  - x` line, either plain or single-quoted, so a real YAML parser
 * would only add a dependency to handle cases that cannot occur.
 */

/** One emitted constant per distinct dictionary, not per model. */
const DICTIONARIES = [
  {
    name: 'CHARSET_V6',
    repo: 'PP-OCRv6_medium_rec_onnx',
    note: 'shared by the medium and small recognizers (50 languages)',
  },
  {
    name: 'CHARSET_V6_TINY',
    repo: 'PP-OCRv6_tiny_rec_onnx',
    note: 'the tiny recognizer only — a much smaller character set',
  },
];

const OUT = new URL('../src/charset.ts', import.meta.url).pathname;

const ymlUrl = (repo: string) =>
  `https://huggingface.co/PaddlePaddle/${repo}/resolve/main/inference.yml`;

/** Undo YAML single-quoted style (`'a'` → `a`, `''''` → `'`); plain scalars pass through. */
function unquote(scalar: string): string {
  if (scalar.length >= 2 && scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  return scalar;
}

/** Escape for a double-quoted TS string literal. */
function escape(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    // Control chars and the two line separators JS once refused inside strings.
    else if (code < 0x20 || code === 0x2028 || code === 0x2029)
      out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

async function fetchDictionary(repo: string): Promise<string[]> {
  const url = ymlUrl(repo);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const lines = (await res.text()).split('\n');

  const start = lines.findIndex((l) => l.trim() === 'character_dict:');
  if (start < 0) throw new Error(`no \`character_dict:\` key in ${repo}/inference.yml`);

  const chars: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // The list ends at the first line that is not one of its items.
    if (!line.startsWith('  - ')) break;
    const ch = unquote(line.slice(4));
    if (Array.from(ch).length !== 1) {
      throw new Error(`${repo} entry ${chars.length} is not one character: ${JSON.stringify(ch)}`);
    }
    chars.push(ch);
  }

  if (chars.length === 0) throw new Error(`${repo} character_dict parsed as empty`);
  return chars;
}

const sections = await Promise.all(
  DICTIONARIES.map(async (d) => {
    const chars = await fetchDictionary(d.repo);
    console.log(`[gen-charset] ${d.repo}: ${chars.length} characters`);
    return (
      `/**\n` +
      ` * ${d.note}.\n` +
      ` *\n` +
      ` * Source: ${ymlUrl(d.repo)}\n` +
      ` * ${chars.length} entries, so the model must have ${chars.length + 2} output classes:\n` +
      ` * 0 is the CTC blank, 1..${chars.length} index this string, ${chars.length + 1} is a space.\n` +
      ` */\n` +
      `export const ${d.name} = "${escape(chars.join(''))}";\n`
    );
  }),
);

const header = `// GENERATED — do not edit. Regenerate with:
//   bun run apps/ocr/scripts/gen-charset.ts
//
// Each constant is one PaddleOCR character dictionary, stored as a single string.
// Split with Array.from — these contain astral characters, so .length/[i] would
// tear surrogate pairs. See decodeCtc() in model.ts for how indices map.

`;

await Bun.write(OUT, header + sections.join('\n'));
console.log(`[gen-charset] wrote ${DICTIONARIES.length} dictionaries to ${OUT}`);
