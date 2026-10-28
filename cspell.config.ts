import type {CSpellSettings} from 'cspell';

const GLOBALLY_IGNORED_WORDS: Readonly<Record<string, string[]>> = {
  names: ['andreww', 'quansync', 'utilery'],
  misc: ['knipignore', 'FEFF'],
  git: [
    'commondir',
    'excludesfile',
    'gitdir',
    'includeif',
    'NOSYSTEM',
    'onbranch',
    'worktreeconfig',
    'worktrees',
  ],
  // POSIX character class names
  posix: ['alnum', 'punct', 'xdigit'],
  englishIshWords: [],
};

export default {
  useGitignore: true,
  enableGlobDot: true,
  ignorePaths: [
    '**/.gitignore',
    '**/.git/**',
    '**/pnpm-lock.yaml',
    'patches/**',
    '.agents/guidelines.md',
  ],
  dictionaries: ['npm', 'node', 'typescript', 'fullstack'],
  words: Object.values(GLOBALLY_IGNORED_WORDS).flat(),
  overrides: [],
} satisfies CSpellSettings;
