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
    },
  },
  {
    // Shims run in the app iframe, not in Bun: tsconfig excludes them, and each carries
    // `@ts-nocheck` because it is typechecked through `bundled-types/index.d.ts` instead.
    files: ['src/shims/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      // Under `@ts-nocheck` no annotation is checked, so an `any` costs nothing here.
      '@typescript-eslint/no-explicit-any': 'off',
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
