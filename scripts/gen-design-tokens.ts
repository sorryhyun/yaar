/**
 * Regenerates the checked-in, generated stylesheets from the canonical token
 * data in packages/shared/src/design/.
 *
 *   bun scripts/gen-design-tokens.ts
 *
 * Currently emits:
 *   - packages/frontend/src/styles/base/tokens.css (OS shell)
 *
 * The app-iframe CSS needs no file: the compiler imports it from @yaar/shared
 * at runtime. A frontend test asserts tokens.css matches this generator.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShellTokensCss } from '../packages/shared/src/design/shell-css.ts';

const target = join(import.meta.dir, '../packages/frontend/src/styles/base/tokens.css');
writeFileSync(target, buildShellTokensCss());
console.log(`wrote ${target}`);
