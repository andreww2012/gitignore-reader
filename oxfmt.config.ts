import type {OxfmtConfig} from 'oxfmt';

export default {
  printWidth: 100,
  singleQuote: true,
  bracketSpacing: false,
  ignorePatterns: [
    // Ignore all *files* starting with a dot, unless they contain another dot in the name
    '.*',
    '!.*/',
    '!.*.*',

    // This might conflict with ESLint rules for these files,
    // plus the resulting formatting is more opinionated
    '*.html',
    '*.json',
    '*.md',

    'pnpm-lock.yaml',
    'yarn.lock',
  ],
} satisfies OxfmtConfig;
