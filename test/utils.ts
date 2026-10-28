import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {lint as cspellLint} from 'cspell';
import {ESLint} from 'eslint';
import {arrayChunks} from 'utilery/array';
import {withConcurrencyLimit} from 'utilery/async';
import {toForwardSlashes} from 'utilery/path';
import {isDirectorySync} from 'utilery/server';
import {type Gitignore, readGitignoreSync} from '../src/index.ts';

// cspell:ignore SYSTEMROOT

const collator = new Intl.Collator('en');

// cspell runs that overlap mix up their roots, so they run one at a time
const cspellLintOneAtATime = withConcurrencyLimit(cspellLint, 1);

const NON_ASCII_REGEX = /\P{ASCII}/u;
// They match a single byte in git, but a whole character in ESLint
const BYTE_WILDCARD_REGEX = /[?[]/;

/** Symlinks to files need extra privileges on Windows, unlike junctions to directories */
export const symlinkOrSkip = (
  target: string,
  link: string,
  context: {skip: (note: string) => void},
) => {
  try {
    fs.symlinkSync(target, link, isDirectorySync(target) ? 'junction' : 'file');
  } catch {
    context.skip('Symlinks are not available');
  }
};

export interface FileTree {
  [name: string]: FileTree | string;
}

const writeTree = (directory: string, tree: FileTree) => {
  fs.mkdirSync(directory, {recursive: true});
  Object.entries(tree).forEach(([name, value]) => {
    const entryPath = path.join(directory, name);
    if (typeof value === 'string') {
      fs.mkdirSync(path.dirname(entryPath), {recursive: true});
      fs.writeFileSync(entryPath, value);
    } else {
      writeTree(entryPath, value);
    }
  });
};

export interface Fixture {
  /** The directory with the repository (or just files) */
  root: string;
  home: string;
  /** Isolates git and the tested code from the real git config */
  env: Record<'GIT_CONFIG_GLOBAL' | 'GIT_CONFIG_NOSYSTEM' | 'HOME' | 'XDG_CONFIG_HOME', string>;
  git: (
    gitArguments: readonly string[],
    options?: {cwd?: string; input?: string; env?: Readonly<Record<string, string>>},
  ) => string;
  write: (tree: FileTree) => void;
  writeInfoExclude: (content: string) => void;
  /** Writes the default global ignore file, `~/.config/git/ignore` */
  writeGlobalIgnore: (content: string) => void;
}

/** Creates a temporary directory, removed after all tests of the file */
export const createFixture = (tree: FileTree = {}, {gitInit = true} = {}): Fixture => {
  // The native one also expands short names on Windows, like git does
  const temporaryDirectory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-reader-')),
  );
  onTestFinished(() => {
    fs.rmSync(temporaryDirectory, {recursive: true, force: true});
  });
  const root = path.join(temporaryDirectory, 'repo');
  const home = path.join(temporaryDirectory, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
  };
  const git: Fixture['git'] = (
    gitArguments,
    // The type works around a TypeScript 7.1 bug that loses it here:
    // https://github.com/microsoft/TypeScript/issues/64974
    {cwd = root, input, env: gitEnv = env}: Parameters<Fixture['git']>[1] = {},
  ) =>
    // eslint-disable-next-line sonar/no-os-command-from-path -- the tests need the installed git
    execFileSync('git', gitArguments, {
      cwd,
      env: {...gitEnv, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT},
      encoding: 'utf8',
      // `check-ignore` prints a lot for thousands of paths
      maxBuffer: Number.POSITIVE_INFINITY,
      // Warnings would clutter the output, the error has them anyway
      stdio: 'pipe',
      ...(input != null && {input}),
    });
  if (gitInit) {
    git(['init', '--quiet']);
    // Matches the default of `ignoreCase` regardless of the platform
    git(['config', 'core.ignoreCase', 'false']);
    // Git creates it with comments only, which would just be another source in every test
    fs.rmSync(path.join(root, '.git', 'info', 'exclude'), {force: true});
  }
  writeTree(root, tree);
  return {
    root,
    home,
    env,
    git,
    write: (subtree) => {
      writeTree(root, subtree);
    },
    writeInfoExclude: (content) => {
      writeTree(path.join(root, '.git', 'info'), {exclude: content});
    },
    writeGlobalIgnore: (content) => {
      writeTree(path.join(env.XDG_CONFIG_HOME, 'git'), {ignore: content});
    },
  };
};

interface GitCheckResult {
  ignored: boolean;
  /** As printed by git */
  source?: string;
  line?: number;
  pattern?: string;
}

const runCheckIgnore = (fixture: Fixture, paths: readonly string[]) => {
  try {
    return fixture.git(['check-ignore', '-z', '--stdin', '-v', '-n', '--no-index'], {
      input: paths.join('\0'),
    });
  } catch (error) {
    // Exit code 1 means that nothing is ignored
    if (!(error instanceof Error && 'status' in error && error.status === 1 && 'stdout' in error)) {
      throw error;
    }
    return typeof error.stdout === 'string' ? error.stdout : '';
  }
};

/** Runs `git check-ignore --verbose --non-matching` for the paths, relative to the repository */
export const gitCheckIgnore = (fixture: Fixture, paths: readonly string[]): GitCheckResult[] => {
  if (paths.length === 0) {
    return [];
  }
  // The source, the line, the pattern and the path for each path
  const records = arrayChunks(runCheckIgnore(fixture, paths).split('\0'), 4);
  return paths.map((_, index) => {
    const [source = '', line = '', pattern = ''] = records[index] || [];
    return {
      ignored: pattern.length > 0 && !pattern.startsWith('!'),
      ...(source.length > 0 && {source, line: Number(line), pattern}),
    };
  });
};

/** Lists every file and directory, relative to the directory, POSIX-style, skipping `.git` */
const listTree = (directory: string) =>
  fs
    .readdirSync(directory, {recursive: true, withFileTypes: true})
    .flatMap((entry) => {
      const relativePath = toForwardSlashes(
        path.relative(directory, path.join(entry.parentPath, entry.name)),
      );
      return relativePath.split('/').includes('.git')
        ? []
        : {path: relativePath, isDirectory: entry.isDirectory()};
    })
    .toSorted((a, b) => collator.compare(a.path, b.path));

/** Compares `check` with `git check-ignore` for every file and directory of the fixture */
export const compareWithGit = (fixture: Fixture, gitignore: Gitignore) => {
  const entries = listTree(fixture.root);
  const gitResults = gitCheckIgnore(
    fixture,
    entries.map((entry) => entry.path),
  );
  const mismatches = entries.flatMap((entry, index) => {
    const result = gitignore.check(path.join(fixture.root, entry.path), entry.isDirectory);
    const gitResult = gitResults[index];
    const expected = gitResult && {
      ignored: gitResult.ignored,
      pattern: gitResult.pattern,
      line: gitResult.line,
      source: gitResult.source == null ? undefined : path.resolve(fixture.root, gitResult.source),
    };
    const actual = {
      ignored: result.ignored,
      pattern: result.rule?.pattern,
      line: result.rule?.line,
      source: result.source?.path,
    };
    return isDeepStrictEqual(actual, expected) ? [] : {path: entry.path, expected, actual};
  });
  return {entries, gitResults, mismatches};
};

/**
 * ESLint must ignore the same files as git with the patterns of `toEslintIgnores`, read for `cwd`.
 * Returns the mismatches
 */
export const compareWithEslint = async (
  fixture: Fixture,
  cwd: string,
  {entries, gitResults}: ReturnType<typeof compareWithGit>,
) => {
  const gitignore = readGitignoreSync({cwd, env: fixture.env, sources: {globalIgnoreFile: true}});
  const ignores = gitignore.toEslintIgnores();
  // The patterns only differ from git there, as documented
  const hasByteWildcards = gitignore.sources.some((source) =>
    source.rules.some((rule) => BYTE_WILDCARD_REGEX.test(rule.pattern)),
  );
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    // Files matched only by patterns ending with `/*` are not linted
    overrideConfig: [{files: ['**/?*']}, {ignores}],
  });
  const cwdPrefix = toForwardSlashes(path.relative(fixture.root, cwd));
  const results = await Promise.all(
    entries.map(async (entry, index) => {
      const isChecked =
        !entry.isDirectory &&
        // ESLint always ignores them
        !entry.path.split('/').includes('node_modules') &&
        (cwdPrefix.length === 0 || entry.path.startsWith(`${cwdPrefix}/`)) &&
        !(hasByteWildcards && NON_ASCII_REGEX.test(entry.path));
      if (!isChecked) {
        return [];
      }
      const expected = gitResults[index]?.ignored;
      const isActual = await eslint.isPathIgnored(path.join(fixture.root, entry.path));
      return isActual === expected
        ? []
        : {path: entry.path, cwd: cwdPrefix, ignores, expected, actual: isActual};
    }),
  );
  return results.flat();
};

/** Runs cspell in `cwd`, where its config is, and returns the files it checks */
const findFilesCheckedByCspell = async (
  fixture: Fixture,
  cwd: string,
  ignorePaths: readonly string[],
) => {
  const checkedPaths = new Set<string>();
  const errors: string[] = [];
  await cspellLintOneAtATime(
    ['**'],
    {
      root: cwd,
      config: {
        url: pathToFileURL(path.join(cwd, 'cspell.json')),
        settings: {
          // cspell takes a path like `a:b` for a URL and fails to read the file
          ignorePaths: [...ignorePaths, '**/*:*'],
          enableGlobDot: true,
        },
      },
      // Only the files it finds matter
      skipValidation: true,
    },
    {
      progress: (item) => {
        if (item.type === 'ProgressFileComplete') {
          checkedPaths.add(toForwardSlashes(path.relative(fixture.root, item.filename)));
        }
      },
      error: (message) => {
        errors.push(message);
      },
    },
  );
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return checkedPaths;
};

/**
 * The files cspell checks in `cwd` without the patterns: it skips some on its own, like the ones in
 * `node_modules`
 */
export const findFilesCheckableByCspell = (fixture: Fixture, cwd: string) =>
  findFilesCheckedByCspell(fixture, cwd, []);

/**
 * cspell must check the files that git doesn't ignore, and nothing in `.git`, with the patterns of
 * `toCspellIgnorePaths` read for `cwd`.
 * Pass the result of `findFilesCheckableByCspell` to reuse it while the files stay the same.
 * Returns the mismatches
 */
export const compareWithCspell = async (
  fixture: Fixture,
  cwd: string,
  {entries, gitResults}: ReturnType<typeof compareWithGit>,
  checkablePathsPromise = findFilesCheckableByCspell(fixture, cwd),
) => {
  const ignorePaths = readGitignoreSync({
    cwd,
    env: fixture.env,
    sources: {globalIgnoreFile: true},
  }).toCspellIgnorePaths();
  const [checkablePaths, checkedPaths] = await Promise.all([
    checkablePathsPromise,
    findFilesCheckedByCspell(fixture, cwd, ignorePaths),
  ]);
  const cwdPrefix = toForwardSlashes(path.relative(fixture.root, cwd));
  return [
    ...entries.flatMap((entry, index) => {
      if (!checkablePaths.has(entry.path)) {
        return [];
      }
      const expected = gitResults[index]?.ignored;
      const isIgnoredByCspell = !checkedPaths.has(entry.path);
      return isIgnoredByCspell === expected
        ? []
        : {path: entry.path, cwd: cwdPrefix, ignorePaths, expected, actual: isIgnoredByCspell};
    }),
    // The entries leave out `.git`
    ...[...checkedPaths]
      .filter((checkedPath) => checkedPath.split('/').includes('.git'))
      .map((checkedPath) => ({
        path: checkedPath,
        cwd: cwdPrefix,
        ignorePaths,
        expected: true,
        actual: false,
      })),
  ];
};
