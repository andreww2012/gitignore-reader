// Compares the results with git on random repositories: the matcher directly, and the patterns of
// `toEslintIgnores` by letting ESLint apply them
import fs from 'node:fs';
import path from 'node:path';
import {mapTimes} from 'utilery/function';
import {readGitignoreSync} from '../src/index.ts';
import {
  type FileTree,
  type Fixture,
  compareWithEslint,
  compareWithGit,
  createFixture,
} from './utils.ts';

const RUN_COUNT = Number(process.env.PARITY_RUNS) || 60;
const SEED = Number(process.env.PARITY_SEED) || 20_261_018;

// Valid on every platform.
// ESLint ignores `node_modules` and `.git` on its own, so they are left out
const NAMES = [
  'a',
  'b',
  'ab',
  'abc',
  'foo',
  'Foo',
  'bar',
  '.hidden',
  'x.js',
  'y.ts',
  'z.log',
  'dist',
  'a b',
  '[id]',
  '(group)',
  '{c,d}',
  '#hash',
  '!bang',
  'é',
  'É.txt',
  'aé',
  'ü.js',
  '日本',
  'a-b',
  'a]',
  'Abc',
] as const;

const WILDCARD_SEGMENTS = [
  '*',
  'a*',
  '*.js',
  '*b',
  '?oo',
  '[ab]*',
  '[!a]*',
  '[a-c]',
  '[[:alpha:]]*',
  '**',
  'a**',
  '*.*',
  String.raw`\[id]`,
  '[]]',
  '[!-0]*',
  '[[:punct:]]*',
  '[A-Z]*',
  '[a-]',
  '*.[jt]s',
  '***',
  String.raw`a\ b`,
  // minimatch mishandles some escapes after a star
  '*#',
  '?]',
  '*)',
  '*}',
  // These behave differently with `core.ignoreCase`
  '[A]*',
  '[!A]*',
  '[A-A]*',
  String.raw`\Abc`,
  'É*',
  // Git matches bytes, and non-ASCII characters have several of them
  '?',
  '??',
  '???.js',
  '[!a]',
  '*[é]',
  '[é][é]',
  'a?',
  // Patterns with an empty segment, like `a//b` or `/` alone, never match
  '',
] as const;

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    // mulberry32
    state = (state + 0x6d_2b_79_f5) >>> 0;
    const mixed = Math.imul(state ^ (state >>> 15), state | 1);
    const value = mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61));
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

type Random = ReturnType<typeof createRandom>;

const pick = <T>(random: Random, values: readonly [T, ...T[]]) =>
  values[Math.floor(random() * values.length)] ?? values[0];

const GITIGNORE_SPECIAL_CHARS_REGEX = /[*?[\\]/g;
const GITIGNORE_SPECIAL_FIRST_CHAR_REGEX = /^[!#]/;

const createTree = (random: Random, depth: number): FileTree =>
  Array.from({length: 1 + Math.floor(random() * (depth === 0 ? 6 : 4))}).reduce<FileTree>(
    (tree) => {
      const name = pick(random, NAMES);
      // Case-insensitive file systems can't have both `foo` and `Foo`
      if (Object.keys(tree).every((existing) => existing.toLowerCase() !== name.toLowerCase())) {
        tree[name] = depth < 3 && random() < 0.45 ? createTree(random, depth + 1) : `${name}\n`;
      }
      return tree;
    },
    {},
  );

const toGitignoreLiteral = (name: string) =>
  name
    .replaceAll(GITIGNORE_SPECIAL_CHARS_REGEX, String.raw`\$&`)
    .replace(GITIGNORE_SPECIAL_FIRST_CHAR_REGEX, String.raw`\$&`);

const createPattern = (random: Random) => {
  const segmentCount = 1 + Math.floor(random() * 4);
  const segments = mapTimes(segmentCount, () =>
    random() < 0.55 ? toGitignoreLiteral(pick(random, NAMES)) : pick(random, WILDCARD_SEGMENTS),
  );
  return [
    random() < 0.2 ? '!' : '',
    random() < 0.25 ? '/' : '',
    segments.join('/'),
    random() < 0.2 ? '/' : '',
    random() < 0.05 ? '  ' : '',
  ].join('');
};

const createIgnoreFile = (random: Random) =>
  [
    ...mapTimes(1 + Math.floor(random() * 6), () => createPattern(random)),
    random() < 0.3 ? '# comment' : '',
  ].join(random() < 0.2 ? '\r\n' : '\n') + (random() < 0.1 ? '\r' : '');

const listDirectories = (tree: FileTree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? []
      : [`${prefix}${name}`, ...listDirectories(value, `${prefix}${name}/`)],
  );

const createScenario = (seed: number) => {
  const random = createRandom(seed);
  const tree = createTree(random, 0);
  tree['.gitignore'] = createIgnoreFile(random);
  const directories = listDirectories(tree);
  directories.forEach((directory) => {
    const subtree = directory
      .split('/')
      .reduce<FileTree | string | undefined>(
        (current, name) => (typeof current === 'object' ? current[name] : undefined),
        tree,
      );
    if (typeof subtree === 'object' && random() < 0.4) {
      subtree['.gitignore'] = createIgnoreFile(random);
    }
  });
  return {
    tree,
    directories,
    ...(random() < 0.5 && {infoExclude: createIgnoreFile(random)}),
    ...(random() < 0.5 && {globalIgnoreFile: createIgnoreFile(random)}),
    shouldConfigureExcludesFile: random() < 0.5,
    ...(directories.length > 0 && {
      subdirectory: directories[Math.floor(random() * directories.length)],
    }),
    isCaseInsensitive: random() < 0.15,
  };
};

const writeGitSources = (fixture: Fixture, scenario: ReturnType<typeof createScenario>) => {
  if (scenario.infoExclude != null) {
    fixture.writeInfoExclude(scenario.infoExclude);
  }
  if (scenario.globalIgnoreFile != null) {
    if (scenario.shouldConfigureExcludesFile) {
      fs.writeFileSync(path.join(fixture.home, 'global-ignore'), scenario.globalIgnoreFile);
      fs.writeFileSync(fixture.env.GIT_CONFIG_GLOBAL, '[core]\n\texcludesFile = ~/global-ignore\n');
    } else {
      fixture.writeGlobalIgnore(scenario.globalIgnoreFile);
    }
  }
};

const runScenario = async (seed: number) => {
  const scenario = createScenario(seed);
  const fixture = createFixture(scenario.tree);
  if (scenario.isCaseInsensitive) {
    fixture.git(['config', 'core.ignoreCase', 'true']);
  }
  writeGitSources(fixture, scenario);

  // `ignoreCase` comes from `core.ignoreCase`
  const comparison = compareWithGit(
    fixture,
    readGitignoreSync({cwd: fixture.root, env: fixture.env, sources: {globalIgnoreFile: true}}),
  );

  // The patterns are always case-sensitive
  if (scenario.isCaseInsensitive) {
    return {mismatches: comparison.mismatches, eslintMismatches: []};
  }

  // ESLint must ignore the same files with the patterns, from the root and from a subdirectory
  const isSubdirectoryIgnored = comparison.gitResults.some(
    (result, index) => result.ignored && comparison.entries[index]?.path === scenario.subdirectory,
  );
  const eslintBaseDirectories = [
    fixture.root,
    ...(isSubdirectoryIgnored || scenario.subdirectory == null
      ? []
      : [path.join(fixture.root, scenario.subdirectory)]),
  ];
  const eslintMismatches = await Promise.all(
    eslintBaseDirectories.map((cwd) => compareWithEslint(fixture, cwd, comparison)),
  );
  return {mismatches: comparison.mismatches, eslintMismatches: eslintMismatches.flat()};
};

describe('parity with git', () => {
  it.each(mapTimes(RUN_COUNT, (index) => SEED + index))(
    'random repository, seed %i',
    async (seed) => {
      const {mismatches, eslintMismatches} = await runScenario(seed);

      expect(mismatches).toStrictEqual([]);
      expect(eslintMismatches).toStrictEqual([]);
    },
  );
});
