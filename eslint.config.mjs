import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

const projectGlobals = {
  ...globals.browser,
  ...globals.node,
  M: 'readonly',
};

const styleRules = {
  'class-methods-use-this': 'warn',
  'linebreak-style': 'off',
  'max-len': ['error', { code: 140 }],
  'no-await-in-loop': 'off',
  'no-bitwise': 'warn',
  'no-console': 'off',
  'no-param-reassign': 'off',
  'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
  'no-restricted-syntax': 'off',
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    caughtErrors: 'none',
  }],
  'object-curly-spacing': ['error', 'always', {
    arraysInObjects: true,
    objectsInObjects: false,
  }],
};

export default [
  {
    ignores: [
      'build/**',
      'client/lib/legacy-player.js',
      'client/vendor/**',
      'internal/site/dist/**',
      'public/**',
      'release/**',
      'zap-reports/**',
    ],
  },
  js.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: projectGlobals,
      sourceType: 'module',
    },
    rules: styleRules,
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      globals: projectGlobals,
      parserOptions: {
        svelteConfig: './svelte.config.mjs',
      },
    },
    rules: {
      ...styleRules,
      'svelte/no-at-html-tags': 'off',
      'svelte/no-dom-manipulating': 'off',
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['tests/**/*.{js,mjs}'],
    rules: {
      'class-methods-use-this': 'off',
      'max-len': 'off',
      'no-unused-vars': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
