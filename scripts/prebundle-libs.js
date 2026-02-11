#!/usr/bin/env node
/**
 * Pre-bundle @bundled/* libraries into single ESM files for exe embedding.
 *
 * Runs at build time (before build-exe-bundle.js) to produce one .js file
 * per library in dist/bundled-libs/. These are then embedded into the exe
 * via Bun's `with { type: "file" }` import mechanism.
 */

import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'dist', 'bundled-libs');

// Same map as plugins.ts — import name → npm package
const BUNDLED_LIBRARIES = {
  'uuid': 'uuid',
  'lodash': 'lodash-es',
  'date-fns': 'date-fns',
  'clsx': 'clsx',
  'anime': 'animejs',
  'konva': 'konva',
  'three': 'three',
  'cannon-es': 'cannon-es',
  'xlsx': 'xlsx',
  'chart.js': 'chart.js',
  'd3': 'd3',
  'matter-js': 'matter-js',
  'tone': 'tone',
  'pixi.js': 'pixi.js',
  'p5': 'p5',
};

// Resolve esbuild from server's node_modules where it's a devDependency
const resolveDir = join(rootDir, 'packages', 'server');
const require = createRequire(join(resolveDir, 'package.json'));
const esbuild = require('esbuild');

mkdirSync(outDir, { recursive: true });

console.log(`Pre-bundling ${Object.keys(BUNDLED_LIBRARIES).length} libraries into ${outDir}...`);

const results = await Promise.allSettled(
  Object.entries(BUNDLED_LIBRARIES).map(async ([name, pkg]) => {
    const outfile = join(outDir, `${name}.js`);
    try {
      await esbuild.build({
        entryPoints: [pkg],
        bundle: true,
        format: 'esm',
        target: ['es2020'],
        outfile,
        minify: true,
        sourcemap: false,
        logLevel: 'warning',
        absWorkingDir: resolveDir,
      });
      console.log(`  ✓ ${name} (${pkg})`);
      return { name, success: true };
    } catch (err) {
      console.error(`  ✗ ${name} (${pkg}): ${err.message}`);
      return { name, success: false, error: err.message };
    }
  })
);

const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));
if (failed.length > 0) {
  console.error(`\n${failed.length} library(ies) failed to bundle.`);
  process.exit(1);
}

console.log(`\nAll libraries bundled to ${outDir}`);
