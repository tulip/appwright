// ESLint 9 reads only flat config. The shared config is still in eslintrc form, so FlatCompat
// loads it, resolving its plugins from the shared config's own dependencies.
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharedConfig = path.dirname(require.resolve('@empiricalrun/eslint-config/package.json'));
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
  resolvePluginsRelativeTo: sharedConfig,
  recommendedConfig: js.configs.recommended,
});

export default [
  { ignores: ['dist/**', 'example/**', 'node_modules/**', 'eslint.config.mjs'] },
  ...compat.extends('@empiricalrun/eslint-config/playwright'),
  {
    // TypeScript checks these itself; the core rules misread type-only names (an interface
    // method's parameters, the `NodeJS` namespace). `autofix/no-unused-vars` stays on.
    files: ['**/*.ts', '**/*.mts'],
    rules: { 'no-unused-vars': 'off', 'no-undef': 'off' },
  },
];
