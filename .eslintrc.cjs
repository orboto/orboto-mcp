// ORB-1831 - apps/mcp declared a lint script but had no config (eslint
// exited 2 on every run). Mirrors apps/api's config.
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
  },
  rules: {
    // ORB-1831 - `while (true)` pagination / drain loops are the idiom in this
    // codebase; only non-loop constant conditions are a defect signal.
    'no-constant-condition': ['error', { checkLoops: false }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  },
  // ORB-1831 - vitest files load fixtures / node built-ins with a bare
  // require() in a few places; that is a test-runtime convenience, not a
  // module-system violation worth an error in the gate.
  overrides: [
    { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-var-requires': 'off' } },
  ],
};
