import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/server/src/tests/**/*.test.ts',
      'packages/shared/src/tests/**/*.test.ts',
    ],
  },
})
