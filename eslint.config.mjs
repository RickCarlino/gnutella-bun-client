import babelParser from '@babel/eslint-parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        babelOptions: {
          presets: ['@babel/preset-typescript'],
        },
        requireConfigFile: false,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      complexity: ['error', 9],
      'max-lines': [
        'error',
        {
          max: 1000,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
      'constructor-super': 'error',
      'no-const-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-new-symbol': 'error',
      'no-obj-calls': 'error',
      'no-redeclare': 'error',
      'no-setter-return': 'error',
      'no-this-before-super': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
