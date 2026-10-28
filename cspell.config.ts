import type {CSpellSettings} from 'cspell';
import {readGitignoreSync} from './src/index.ts';

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
  enableGlobDot: true,
  ignorePaths: [
    ...readGitignoreSync({
      // eslint-disable-next-line node/no-unsupported-features/node-builtins -- only used in development, on recent Node.js versions
      cwd: import.meta.dirname,
    }).toCspellIgnorePaths(),
    '**/.gitignore',
    '**/pnpm-lock.yaml',
    'patches/**',
    '.agents/guidelines.md',
  ],
  dictionaries: ['npm', 'node', 'typescript', 'fullstack'],
  words: Object.values(GLOBALLY_IGNORED_WORDS).flat(),
  overrides: [],
} satisfies CSpellSettings;
