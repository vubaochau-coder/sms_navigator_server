// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts', 'tests/**/*.ts']
  })),
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Codebase intentionally uses `any` in error handlers and test bodies
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }
      ],
      'no-console': ['error', { allow: ['debug'] }]
    }
  }
);
