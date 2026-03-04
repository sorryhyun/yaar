import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Handle `import x from './file.md' with { type: 'text' }` used in server source.
 * Mirrors the plugin in packages/server/vitest.config.ts.
 */
function mdTextPlugin() {
  return {
    name: 'md-text',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    load(id: string): string | undefined {
      if (id.endsWith('.md')) {
        const content = readFileSync(id, 'utf-8');
        return `export default ${JSON.stringify(content)}`;
      }
    },
  };
}

export default defineConfig({
  plugins: [mdTextPlugin()],
  test: {
    globals: true,
    environment: 'node',
    // Regular tests only — bench files are run via `bun run bench` separately
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Map @yaar/server/foo/bar → packages/server/src/foo/bar
      '@yaar/server': path.resolve(__dirname, '../server/src'),
      // Map @yaar/shared → shared package source (used by server internals transitively)
      '@yaar/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
