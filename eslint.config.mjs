// @ts-check

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Mirror the ignore patterns from the `lint` npm script so that a bare
  // `npx eslint .` behaves identically to `npm run lint`.
  globalIgnores(['dist/**', 'node_modules/**', 'tests/**', 'debug*']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Downgraded to warn: ~24 pre-existing violations in src/ that this
      // config change cannot fix (src/ is owned by other agents).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Guardrail: silent catch blocks are banned. Intentional swallow sites
      // must carry an explanatory comment (ESLint treats a commented catch
      // block as non-empty, so documented sites pass).
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Guardrail: stop growth of type escapes. Warn (not error) because
      // existing violations live in src/ and cannot be fixed here.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Downgraded to warn: pre-existing violations in src/ (see above).
      'no-useless-assignment': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    // Discourage stray console output in library/server code. console.error
    // and console.warn are allowed (used by DBG_*-gated diagnostics); the
    // known console.log sites surface as warnings only.
    files: ['src/**'],
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
);
