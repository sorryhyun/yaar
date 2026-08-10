import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Operational logging goes through `observability/log.ts`, which attaches the
      // session/monitor/agent ids automatically. A bare console.* has none of them, and 300
      // of them is what made the server's own behaviour unreconstructable. The exemptions
      // below are the cases where stdout is not a log; everything else uses createLogger().
      'no-console': 'error',
    },
  },
  {
    files: ['src/tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Where stdout is the product, not a log:
    //  - lifecycle.ts   — the boot banner, remote-mode box and QR code; the CLI talking to
    //                     its user. Its actual logs do use createLogger('lifecycle').
    //  - main/exe-entry — the same, at the process edges.
    //  - dev-bundle-worker — a worker whose stdout IS its result channel (the parent parses
    //                     the JSON it prints); routing that through a logger breaks it.
    //  - lib/**         — documented as standalone utilities with no server-internal
    //                     imports (see CLAUDE.md). Adopting the logger there is a decision
    //                     about that boundary, not a cleanup — deliberately left alone.
    //  - codex/version.ts — dependency-free on purpose; `scripts/codegen/codex-types.js`
    //                     imports it directly. Its `warn` parameter is the seam.
    files: [
      'src/lifecycle.ts',
      'src/main.ts',
      'src/exe-entry.ts',
      'src/http/dev-bundle-worker.ts',
      'src/lib/**/*.ts',
      'src/providers/codex/version.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/providers/codex/generated/**'],
  },
);
