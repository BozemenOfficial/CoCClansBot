import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', '.wrangler/**', 'coverage/**', 'dist/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', AbortSignal: 'readonly', Buffer: 'readonly' } } },
);
