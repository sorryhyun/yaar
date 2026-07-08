// Dev helper: typecheck + compile a single app directory.
//   bun scripts/compile-app.ts apps/anima
import { resolve } from 'path';
import { compileTypeScript, typecheckSandbox, initCompiler } from '../packages/compiler/dist/index.js';

initCompiler({ projectRoot: resolve(import.meta.dir, '..'), isBundledExe: false });

const dir = resolve(process.argv[2] ?? 'apps/anima');
const appJson = await Bun.file(resolve(dir, 'app.json')).json();
console.log(`# ${dir}  bundles=${JSON.stringify(appJson.bundles ?? [])}`);

const tc = await typecheckSandbox(dir);
if (!tc.success) {
  console.error('TYPECHECK DIAGNOSTICS:\n' + (tc.diagnostics ?? []).join('\n'));
}

const res = await compileTypeScript(dir, {
  minify: true,
  title: appJson.name ?? 'App',
  bundles: appJson.bundles ?? [],
});
if (!res.success) {
  console.error('COMPILE FAILED:\n' + (res.errors ?? []).join('\n'));
  process.exit(1);
}
const size = (await Bun.file(res.outputPath!).arrayBuffer()).byteLength;
console.log(`OK → ${res.outputPath}  (${(size / 1024).toFixed(0)} KB)${tc.success ? '' : '  [typecheck had errors]'}`);
