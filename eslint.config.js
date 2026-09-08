import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output, vendored libraries, and the Chrome test-profile dir are not ours to lint.
  globalIgnores([
    'dist',
    'dist-standalone',
    'chrome-test-profile',
    'chrome-extension/lib',
  ]),
  // Web app (React) source.
  {
    files: ['src/**/*.{js,jsx}', 'tests/**/*.js', '*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Chrome extension (MV3): service worker + content/offscreen/popup scripts.
  {
    files: ['server/**/*.js', 'scripts/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', globals: globals.node },
  },
  // These run as classic scripts with the extension APIs and a globally-loaded JSZip.
  {
    files: ['chrome-extension/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        JSZip: 'readonly',
      },
    },
    rules: {
      // Callback signatures (sender, response, msg) and silenced catch params are
      // idiomatic in extension code; don't flag them as unused.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^[A-Z_]' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
