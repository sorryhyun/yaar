export {};
import { suite, eq, ok, throwsWith, type Suite } from './harness';
import {
  projectPath,
  previewWindowIdFor,
  relativizeProjectPaths,
  isImagePath,
  isBinaryPath,
  assetImportLine,
  appIdFromName,
  scaffoldMain,
  parseDiagnostics,
  applyEdits,
  countOccurrences,
  truncateRemoved,
  formatRemoved,
  diffStats,
  changedLineRanges,
  formatLineRanges,
  buildPatch,
  truncatePatch,
  resolveCompileStatus,
} from '../lib';

// Checks over src/lib — the pure layer, which is exactly the part that can be
// exercised without booting the IDE. Each check pins a documented behaviour, not an
// implementation detail: what is asserted below is what the surrounding comments in
// src/lib promise, so a check failing means a promise was broken.

const paths = suite('paths', {
  'projectPath with and without a sub-path'() {
    eq(projectPath('123'), 'projects/123');
    eq(projectPath('123', 'src/main.ts'), 'projects/123/src/main.ts');
  },

  // Namespaced by project so two clones of the same app cannot collide on a window id.
  'preview window ids are namespaced by project'() {
    eq(previewWindowIdFor('123'), 'devtools-preview-123');
    ok(previewWindowIdFor('a') !== previewWindowIdFor('b'), 'distinct projects, distinct ids');
  },

  'host-absolute sandbox paths are rewritten to project-relative'() {
    eq(
      relativizeProjectPaths(
        ['/Users/me/yaar/storage/apps/devtools/projects/999/src/main.ts:6:25: oops'],
        '999',
      ),
      ['src/main.ts:6:25: oops'],
    );
  },

  'every occurrence in a message is rewritten, not just the first'() {
    eq(relativizeProjectPaths(['/a/projects/7/src/x.ts and /a/projects/7/src/y.ts'], '7'), [
      'src/x.ts and src/y.ts',
    ]);
  },

  // The id is interpolated into a RegExp, so anything that is not id-shaped is left alone
  // rather than compiled.
  'a project id that is not id-shaped is refused, not interpolated'() {
    const input = ['/a/projects/.*/src/x.ts'];
    eq(relativizeProjectPaths(input, '.*'), input);
  },

  'image paths are raster only — svg is text'() {
    eq(isImagePath('a/b.png'), true);
    eq(isImagePath('A/B.JPEG'), true);
    eq(isImagePath('a/b.svg'), false);
    eq(isImagePath('a/b.ts'), false);
  },

  'binary paths exclude the JSON-ish assets worth reading'() {
    eq(isBinaryPath('a/b.woff2'), true);
    eq(isBinaryPath('a/b.glb'), true);
    eq(isBinaryPath('a/b.gltf'), false);
    eq(isBinaryPath('a/b.svg'), false);
  },

  'assetImportLine writes a specifier relative to src/main.ts'() {
    eq(assetImportLine('src/assets/my-icon.png'), "import myIcon from './assets/my-icon.png';");
  },

  'assetImportLine declines what the bundler would not inline'() {
    eq(assetImportLine('src/main.ts'), null, 'code is not an asset');
    eq(assetImportLine('assets/x.png'), null, 'outside src/ has no stable specifier');
  },

  // The variable name is derived, and a derived name still has to be a legal identifier.
  'a derived variable name never starts with a digit'() {
    eq(assetImportLine('src/assets/3d-model.glb'), "import dModel from './assets/3d-model.glb';");
    eq(assetImportLine('src/assets/2048.png'), "import asset from './assets/2048.png';");
  },
});

const scaffold = suite('scaffold', {
  'a name slugifies to a deployable id'() {
    eq(appIdFromName('My App', '1'), 'my-app');
    eq(appIdFromName('  Hello--World!! ', '1'), 'hello-world');
  },

  // Both cases are legal project names and illegal app ids; neither may be rejected.
  'a leading digit and an all-non-ASCII name still produce an id'() {
    eq(appIdFromName('2048', '1'), 'app-2048');
    eq(appIdFromName('한글', '77'), 'app-77');
  },

  // deploy's own rule. An id that fails it would be refused much later and elsewhere.
  'every derived id satisfies deploy’s /^[a-z][a-z0-9-]*$/'() {
    const legal = /^[a-z][a-z0-9-]*$/;
    for (const name of ['My App', '2048', '한글', '  Hello--World!! ', '___', 'a']) {
      const id = appIdFromName(name, '42');
      ok(legal.test(id), `${JSON.stringify(name)} produced an illegal id: ${id}`);
    }
  },

  'the scaffold follows the App Authoring Contract'() {
    const src = scaffoldMain('Demo', 'demo');
    ok(src.includes('export default defineApp({'), 'one default defineApp export');
    ok(src.includes("id: 'demo',"), 'the id the compiler compares against app.json');
    ok(!src.includes('document.getElementById'), 'never looks up its own mount point');
  },

  // A Zod params schema makes the compiler import the app in a worker with a stubbed DOM.
  // An html`` template at module scope builds a <template> on import and dies there,
  // taking the whole manifest with it — so the template must sit inside App().
  'the html template stays inside App(), never at module scope'() {
    const src = scaffoldMain('Demo', 'demo');
    const fn = src.indexOf('function App()');
    const template = src.indexOf('html`');
    ok(fn !== -1, 'the scaffold defines App()');
    ok(template !== -1, 'the scaffold uses an html template');
    ok(template > fn, 'the template is evaluated inside App(), not on import');
  },
});

const diagnosticsSuite = suite('parse-diagnostics', {
  'a tsc error line becomes a structured diagnostic'() {
    eq(parseDiagnostics("src/main.ts(12,5): error TS2304: Cannot find name 'x'."), [
      { file: 'src/main.ts', line: 12, message: "Cannot find name 'x'.", severity: 'error' },
    ]);
  },

  'warnings keep their severity'() {
    eq(parseDiagnostics('src/a.ts(3,1): warning TS6133: Unused.')[0]?.severity, 'warning');
  },

  'lines that are not diagnostics are dropped, and the rest still parse'() {
    const out = parseDiagnostics(
      [
        'Compiling...',
        'src/a.ts(1,1): error TS1: one',
        'noise',
        'src/b.ts(2,2): error TS2: two',
      ].join('\n'),
    );
    eq(
      out.map((d) => d.file),
      ['src/a.ts', 'src/b.ts'],
    );
    eq(out.length, 2, 'no phantom entries from the noise lines');
  },

  'empty output is no diagnostics'() {
    eq(parseDiagnostics(''), []);
  },
});

const edits = suite('edits', {
  'search mode replaces the first match only'() {
    eq(applyEdits('x\nx', [{ search: 'x', replace: 'y' }]).content, 'y\nx');
  },

  // A string replacement would expand $&, $1, $` and $' — so a replacement containing a
  // dollar sign would silently corrupt the file. The implementation passes a function.
  'a replacement containing $ is inserted literally'() {
    eq(applyEdits('abc', [{ search: 'b', replace: '$&$1' }]).content, 'a$&$1c');
  },

  'a missing replacement is an error, but an empty one deletes'() {
    throwsWith(() => applyEdits('abc', [{ search: 'b' }]), 'missing replacement text');
    eq(applyEdits('abc', [{ search: 'b', replace: '' }]).content, 'ac');
  },

  'a search string that is not present is refused'() {
    throwsWith(() => applyEdits('abc', [{ search: 'z', replace: 'y' }]), 'search string not found');
  },

  'search and a line range are mutually exclusive'() {
    throwsWith(() => applyEdits('abc', [{ search: 'b', replace: 'y', startLine: 1 }]), 'not both');
  },

  // Opt-in, and only for worker proposals: an edit written at T and applied at T+n by
  // someone else cannot be allowed to guess which match was meant.
  'requireUnique refuses an ambiguous search string and names the count'() {
    throwsWith(
      () => applyEdits('x\nx', [{ search: 'x', replace: 'y' }], { requireUnique: true }),
      'appears 2 times',
    );
    eq(
      applyEdits('x\ny', [{ search: 'y', replace: 'z' }], { requireUnique: true }).content,
      'x\nz',
    );
  },

  'requireUnique is off by default'() {
    eq(applyEdits('x\nx', [{ search: 'x', replace: 'y' }]).content, 'y\nx');
  },

  'a line range with no replacement deletes it'() {
    const out = applyEdits('a\nb\nc\nd\ne', [{ startLine: 2, endLine: 3, anchor: 'b' }]);
    eq(out.content, 'a\nd\ne');
    eq(out.removals, ['b\nc'], 'the removed text is echoed back');
  },

  'a replacement spanning several lines expands in place'() {
    eq(
      applyEdits('a\nb\nc', [{ startLine: 2, endLine: 2, anchor: 'b', replace: 'X\nY' }]).content,
      'a\nX\nY\nc',
    );
  },

  // Line numbers anchor on nothing, so a stale one would splice into the wrong place
  // silently. This is the check that makes a line-range edit safe to hand to an agent.
  'a line-range edit without an anchor is refused, and the anchor is compared trimmed'() {
    throwsWith(() => applyEdits('a\nb', [{ startLine: 1, endLine: 1 }]), 'require anchor');
    throwsWith(
      () => applyEdits('a\nb', [{ startLine: 1, endLine: 1, anchor: 'zzz', replace: 'q' }]),
      'anchor mismatch',
    );
    eq(
      applyEdits('a\n    b\nc', [{ startLine: 2, endLine: 2, anchor: 'b', replace: 'B' }]).content,
      'a\nB\nc',
    );
  },

  'an out-of-range line range is refused rather than clamped'() {
    throwsWith(() => applyEdits('a\nb', [{ startLine: 0, anchor: 'a' }]), 'invalid line range');
    throwsWith(
      () => applyEdits('a\nb', [{ startLine: 3, endLine: 2, anchor: 'a' }]),
      'invalid line range',
    );
    throwsWith(
      () => applyEdits('a\nb', [{ startLine: 5, anchor: 'a' }]),
      'past the end of the file',
    );
  },

  // An endLine past EOF is the one that clamps: "to the end" is unambiguous.
  'an endLine past the end of the file runs to the end'() {
    const out = applyEdits('a\nb\nc\nd\ne', [{ startLine: 4, endLine: 99, anchor: 'd' }]);
    eq(out.content, 'a\nb\nc');
    eq(out.removals, ['d\ne']);
  },

  'later edits in a batch see the text earlier ones left behind'() {
    const out = applyEdits('one\ntwo\nthree', [
      { search: 'one', replace: '1' },
      { startLine: 2, endLine: 2, anchor: 'two', replace: '2' },
    ]);
    eq(out.content, '1\n2\nthree');
  },

  'a failing edit names its index within the batch'() {
    throwsWith(
      () =>
        applyEdits('one\ntwo', [
          { search: 'one', replace: '1' },
          { search: 'nope', replace: 'x' },
          { search: 'two', replace: '2' },
        ]),
      'edit 2 of 3',
    );
  },

  'a lone edit is not labelled as one of one'() {
    throwsWith(
      () => applyEdits('a', [{ search: 'z', replace: 'y' }]),
      'edit: search string not found',
    );
  },

  'countOccurrences counts non-overlapping matches'() {
    eq(countOccurrences('aaaa', 'aa'), 2, 'non-overlapping');
    eq(countOccurrences('aaa', 'a'), 3);
    eq(countOccurrences('abc', 'z'), 0);
    eq(countOccurrences('abc', ''), 0, 'an empty search matches nothing, not everything');
  },
});

const removedText = suite('removed-text', {
  'short text passes through untouched'() {
    eq(truncateRemoved('short'), 'short');
    eq(truncateRemoved('x'.repeat(500)).length, 500, 'exactly at the cap is not truncated');
  },

  // Both edges are kept: a wrong splice is usually visible at one of them, and both
  // edges together beat twice as much head.
  'long text keeps both edges and states how much was elided'() {
    const out = truncateRemoved('0123456789', 5);
    ok(out.startsWith('012'), `head kept: ${JSON.stringify(out)}`);
    ok(out.endsWith('89'), `tail kept: ${JSON.stringify(out)}`);
    ok(out.includes('[5 chars elided]'), `elision counted: ${JSON.stringify(out)}`);
  },

  'one removal formats as itself; several share the budget and are labelled'() {
    eq(formatRemoved(['abc']), 'abc');
    const many = formatRemoved(['a', 'b']);
    ok(many.includes('edit 1'), many);
    ok(many.includes('edit 2'), many);
    ok(many.includes('a') && many.includes('b'), many);
  },

  'a big batch stays bounded'() {
    const removals = Array.from({ length: 20 }, () => 'x'.repeat(5000));
    const out = formatRemoved(removals);
    ok(out.length < 20 * 300, `expected a bounded result, got ${out.length} chars`);
  },
});

const diff = suite('diff', {
  // A no-op write must be distinguishable from a rewrite, or the Changes panel records
  // an empty diff for every autosave.
  'identical text is 0/0 and no ranges'() {
    eq(diffStats('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
    eq(changedLineRanges('a\nb\n', 'a\nb\n'), []);
  },

  'a pure insertion counts only additions'() {
    eq(diffStats('a\n', 'a\nb\n'), { added: 1, removed: 0 });
  },

  'a modification counts one of each'() {
    eq(diffStats('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
  },

  // A removal and an insertion in the same place are one edit to a reader, not two.
  'a modification merges into a single range, numbered in the new text'() {
    eq(changedLineRanges('a\nb\nc\n', 'a\nB\nc\n'), [{ start: 2, end: 2 }]);
  },

  'ranges read the way a reader writes them'() {
    eq(formatLineRanges([]), '');
    eq(
      formatLineRanges([
        { start: 12, end: 12 },
        { start: 40, end: 44 },
      ]),
      '12, 40-44',
    );
  },

  'an overflowing range list states the overflow instead of dropping it'() {
    eq(
      formatLineRanges(
        [
          { start: 1, end: 1 },
          { start: 3, end: 3 },
          { start: 5, end: 5 },
        ],
        2,
      ),
      '1, 3, +1 more',
    );
  },

  'a patch names the file and both sides of the change'() {
    const patch = buildPatch('f.ts', 'a\n', 'b\n');
    ok(patch.includes('f.ts'), patch);
    ok(patch.includes('-a'), patch);
    ok(patch.includes('+b'), patch);
  },

  // Cutting mid-hunk is deliberate: diff2html renders a short hunk, and dropping whole
  // hunks would lose the top of a large rewrite, which is what a reader looks at first.
  'truncation reports the full length so the caller can say how much is hidden'() {
    eq(truncatePatch('a\nb\nc', 5), { patch: 'a\nb\nc', truncated: false, totalLines: 3 });
    eq(truncatePatch('a\nb\nc\nd', 2), { patch: 'a\nb', truncated: true, totalLines: 4 });
  },
});

const compileStatus = suite('compile-status', {
  'a bundle that never succeeded decides the verdict alone'() {
    eq(resolveCompileStatus('idle', 'clean'), 'idle');
    eq(resolveCompileStatus('compiling', 'clean'), 'compiling');
    eq(resolveCompileStatus('error', 'clean'), 'error');
  },

  // The whole reason this reducer exists. "It built and nobody type checked the current
  // bytes" is a third answer, and reporting it as success once waved a project with six
  // live type errors through as clean.
  'built but unchecked is neither success nor error'() {
    eq(resolveCompileStatus('success', 'unknown'), 'unchecked');
  },

  'both halves clean is the only success'() {
    eq(resolveCompileStatus('success', 'clean'), 'success');
    eq(resolveCompileStatus('success', 'errors'), 'error');
  },
});

export const libSuites: Suite[] = [
  paths,
  scaffold,
  diagnosticsSuite,
  edits,
  removedText,
  diff,
  compileStatus,
];
