import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import type { Plugin } from 'vite'

/**
 * Vite plugin to handle Bun-style `import x from './file.md' with { type: 'text' }`.
 * Vitest uses Vite's import analysis which chokes on .md files — this converts
 * them to ES modules that export the file contents as a string.
 */
function mdTextPlugin(): Plugin {
  return {
    name: 'md-text',
    load(id) {
      if (id.endsWith('.md')) {
        const content = readFileSync(id, 'utf-8')
        return `export default ${JSON.stringify(content)}`
      }
    },
  }
}

export default defineConfig({
  plugins: [mdTextPlugin()],
  test: {
    globals: true,
    include: [
      'src/tests/**/*.test.ts',
    ],
  },
})
