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
      // The server bans bare `console.*` because its operational logging carries
      // session/monitor/agent ids. This package has no session to name and no logger to
      // reach for — that is the point of the boundary — so console is the only channel
      // these utilities have, and the server's own eslint config already exempted
      // `src/lib/**` for exactly this reason before the code moved here.
      'no-console': 'off',
    },
  },
  {
    files: ['src/tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
