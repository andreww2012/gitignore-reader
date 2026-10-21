import os from 'node:os';
import path from 'node:path';
import {type QuansyncGenerator, quansync} from 'quansync';
import {readDirectories, readFileGroups, readFiles} from './fs.ts';
import {
  type ConfigEntry,
  type Env,
  expandGitConfigFiles,
  findConfigEntry,
  getEnvironmentConfig,
  isTrueEntry,
  isTruthyGitValue,
  parseGitConfig,
  resolveConfigPath,
} from './git-config.ts';
import {type Gitignore, createGitignoreBuilder} from './gitignore.ts';
import {getAncestors, isPathInside, joinRelativePath, toPath, toPosixPath} from './path.ts';
import {type GitRepository, discoverRepository} from './repository.ts';

/** Which sources of the rules to read, and how */
export interface GitignoreSourcesOptions {
  /**
   * The global ignore file, git's `core.excludesFile` option.
   * `true` reads git config files to find it (falling back to `$XDG_CONFIG_HOME/git/ignore` or
   * `~/.config/git/ignore`, like git), a string or a URL sets the path.
   * Only used inside a git repository
   * @default true
   */
  excludesFile?: boolean | string | URL;

  /**
   * Whether to read the repository's `$GIT_DIR/info/exclude` file
   * @default true
   */
  infoExclude?: boolean;

  /**
   * Names of per-directory ignore files.
   * In the same directory, files listed later take precedence
   * @default ['.gitignore']
   */
  fileNames?: readonly string[];

  /**
   * Paths of more ignore files, relative to `cwd`.
   * Each one is read like an ignore file from `fileNames` in its directory, but takes precedence
   * over them.
   * Unlike those, it's read even if its directory isn't searched, but not if it's outside of `root`
   * @default []
   */
  files?: readonly (string | URL)[];

  /**
   * Whether to read ignore files in the subdirectories of `cwd`.
   * Like git, ignored directories are not searched
   * @default true
   */
  nested?: boolean;

  /**
   * Names of directories (at any depth) not to search for nested ignore files in, like
   * `['node_modules']`: that's faster where they are not ignored.
   * They are not ignored because of that, but git does read the ignore files in them
   * @default []
   */
  skipDirectories?: readonly string[];

  /**
   * Whether to ignore submodules listed in `.gitmodules`.
   * Git doesn't ignore them, but their files belong to other repositories
   * @default true
   */
  submodules?: boolean;

  /**
   * Whether to ignore directories with their own `.git` directory or file, such as cloned
   * repositories and linked worktrees, found during the search.
   * Git doesn't look into them either.
   * Only used inside a git repository
   * @default true
   */
  nestedRepositories?: boolean;
}

export interface ReadGitignoreOptions {
  /**
   * The directory to read the rules for: ignore files are read in it, in its parents
   * (up to the root of the repository) and in its subdirectories.
   * Relative paths given to the matcher are resolved against it, and `toEslintIgnores` returns
   * patterns relative to it
   * @default process.cwd()
   */
  cwd?: string | URL;

  /**
   * The topmost directory whose ignore files are read.
   * Inside a git repository, it can only narrow the search, since git never reads ignore files
   * above the working tree.
   * Outside a repository, it defaults to the filesystem root
   * @default the top-level directory of the working tree
   */
  root?: string | URL;

  /** Which sources of the rules to read, and how */
  sources?: GitignoreSourcesOptions;

  /**
   * Whether to match case-insensitively.
   * Git does that if `core.ignoreCase` is set, which happens automatically on case-insensitive file
   * systems, like on macOS and Windows.
   * Doesn't affect `toEslintIgnores`, since ESLint always matches case-sensitively
   * @default `core.ignoreCase` from git config, `false` outside of a git repository
   */
  ignoreCase?: boolean;

  /**
   * Environment variables to use: `HOME`, `XDG_CONFIG_HOME` and the ones git uses to find
   * its config files (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` and
   * `GIT_CONFIG_COUNT` with the related variables)
   * @default process.env
   */
  env?: Env;
}

const DEFAULT_FILE_NAMES: readonly string[] = ['.gitignore'];

const DOT_GIT = '.git';
const BRANCH_REF_PREFIX = 'ref: refs/heads/';

interface GitEnvironment {
  env: Env;
  home: string;
  xdgConfigHome: string;
}

interface IgnoreFile {
  path: string;
  followSymlinks: boolean;
}

interface IgnoreFileInDirectory extends IgnoreFile {
  /** Relative to the base directory */
  directory: string;
}

interface ConfigFile {
  path: string;
  content: string | undefined;
}

const getGitEnvironment = (env: Env) => {
  const home = env.HOME || os.homedir();
  return {env, home, xdgConfigHome: env.XDG_CONFIG_HOME || path.join(home, '.config')};
};

/** In the order of precedence */
const getConfigPaths = (repository: GitRepository, {env, home, xdgConfigHome}: GitEnvironment) => {
  let systemPaths: string[] = [];
  if (env.GIT_CONFIG_SYSTEM != null) {
    systemPaths = [env.GIT_CONFIG_SYSTEM];
  } else if (process.platform !== 'win32') {
    // The real path depends on how git was built, this is the most common one
    systemPaths = ['/etc/gitconfig'];
  }
  const globalPaths =
    env.GIT_CONFIG_GLOBAL == null
      ? [path.join(xdgConfigHome, 'git', 'config'), path.join(home, '.gitconfig')]
      : [env.GIT_CONFIG_GLOBAL];
  return {
    main: [
      ...(isTruthyGitValue(env.GIT_CONFIG_NOSYSTEM) ? [] : systemPaths),
      ...globalPaths,
      ...(repository.commonDirectory ? [path.join(repository.commonDirectory, 'config')] : []),
    ].filter((configPath) => configPath.length > 0),
    ...(repository.gitDirectory != null && {
      worktree: path.join(repository.gitDirectory, 'config.worktree'),
    }),
  };
};

const getSubmodulePaths = (content: string) =>
  [
    ...parseGitConfig(content)
      .reduce((entries, entry) => {
        if (
          entry.section === 'submodule' &&
          entry.subsection != null &&
          entry.key === 'path' &&
          entry.value
        ) {
          entries.set(entry.subsection, entry);
        }
        return entries;
      }, new Map<string, ConfigEntry>())
      .values(),
  ].flatMap(({value = '', line}) => {
    const segments = toPosixPath(value).split('/');
    const submodulePath = segments
      .filter((segment) => segment.length > 0 && segment !== '.')
      .join('/');
    return submodulePath.length === 0 || value.startsWith('/') || segments.includes('..')
      ? []
      : {path: submodulePath, line};
  });

// Every entry of every config file git would read, in the order of precedence
function* readGitConfig(
  files: {main: ConfigFile[]; worktree?: ConfigFile},
  {env, home}: GitEnvironment,
  {gitDirectories, head}: {gitDirectories: string[]; head?: string},
): QuansyncGenerator<ConfigEntry[]> {
  const context = {
    home,
    gitDirectories,
    ...(head?.startsWith(BRANCH_REF_PREFIX) && {
      branch: head.slice(BRANCH_REF_PREFIX.length).trim(),
    }),
  };
  const entries = yield* expandGitConfigFiles(files.main, context);
  if (files.worktree && isTrueEntry(findConfigEntry(entries, 'extensions', 'worktreeconfig'))) {
    entries.push(...(yield* expandGitConfigFiles([files.worktree], context)));
  }
  entries.push(...getEnvironmentConfig(env));
  return entries;
}

/** Returns `undefined` if `core.excludesFile` is set to an empty value */
const getExcludesFilePath = (
  entries: readonly ConfigEntry[],
  {home, xdgConfigHome}: GitEnvironment,
  workTree: string,
) => {
  const entry = findConfigEntry(entries, 'core', 'excludesfile');
  if (entry == null) {
    return path.join(xdgConfigHome, 'git', 'ignore');
  }
  return entry.value ? resolveConfigPath(entry.value, home, workTree) : undefined;
};

interface SearchContext {
  cwd: string;
  skippedNames: ReadonlySet<string>;
  shouldIgnoreNestedRepositories: boolean;
  toRelative: (absolutePath: string) => string;
  getIgnoreFiles: (directoryPath: string, hasFile: (name: string) => boolean) => IgnoreFile[];
  isDirectoryIgnored: (relativePath: string) => boolean;
  addIgnoreFiles: (
    ignoreFiles: readonly IgnoreFileInDirectory[],
    contents: readonly (string | undefined)[],
  ) => void;
  addNestedRepository: (directory: string) => void;
}

// Breadth-first, so that a batch of directories is read at once in async mode
function* searchNestedIgnoreFiles(context: SearchContext): QuansyncGenerator<void> {
  const {cwd, skippedNames, toRelative} = context;
  let level = [{path: cwd, relativePath: toRelative(cwd), isStart: true}];
  while (level.length > 0) {
    const listings = yield* readDirectories(level.map((directory) => directory.path));
    const directories = level.flatMap((directory, index) => {
      const entries = listings[index];
      if (!entries) {
        return [];
      }
      if (
        context.shouldIgnoreNestedRepositories &&
        !directory.isStart &&
        entries.some((entry) => entry.name === DOT_GIT)
      ) {
        context.addNestedRepository(directory.relativePath);
        return [];
      }
      return {...directory, entries};
    });

    // The ignore files of `cwd` are read with the ones of its parents
    const ignoreFiles = directories.flatMap((directory) =>
      directory.isStart
        ? []
        : context
            .getIgnoreFiles(directory.path, (name) =>
              directory.entries.some((entry) => entry.name === name && entry.type === 'file'),
            )
            .map((file) => ({...file, directory: directory.relativePath})),
    );
    context.addIgnoreFiles(ignoreFiles, yield* readFiles(ignoreFiles));

    level = directories.flatMap((directory) =>
      directory.entries
        .flatMap((entry) =>
          entry.type === 'directory' && !skippedNames.has(entry.name) ? entry.name : [],
        )
        // The order of entries depends on the file system, but the order of sources must not
        .toSorted()
        .flatMap((name) => {
          const relativePath = joinRelativePath(directory.relativePath, name);
          return context.isDirectoryIgnored(relativePath)
            ? []
            : {path: path.join(directory.path, name), relativePath, isStart: false};
        }),
    );
  }
}

function* readGitignoreGenerator(options: ReadGitignoreOptions = {}): QuansyncGenerator<Gitignore> {
  const {env = process.env, sources = {}} = options;
  const {
    excludesFile = true,
    infoExclude = true,
    fileNames = DEFAULT_FILE_NAMES,
    files = [],
    nested = true,
    skipDirectories = [],
    submodules = true,
    nestedRepositories = true,
  } = sources;
  const cwd = path.resolve(toPath(options.cwd || process.cwd()));
  const {repository, head, realGitDirectory} = yield* discoverRepository(cwd);
  const base = repository?.workTree || path.parse(cwd).root;

  let top = base;
  if (options.root != null) {
    const root = path.resolve(cwd, toPath(options.root));
    if (!isPathInside(cwd, root)) {
      throw new Error(`\`cwd\` (${cwd}) must be inside \`root\` (${root})`);
    }
    if (isPathInside(root, base)) {
      top = root;
    }
  }

  const ancestors = getAncestors(cwd);
  const aboveTopIndex = ancestors.findIndex((ancestor) => !isPathInside(ancestor, top));
  // From `top` down to `cwd`
  const searchedAncestors = (
    aboveTopIndex === -1 ? ancestors : ancestors.slice(0, aboveTopIndex)
  ).toReversed();

  const extraFilePaths = [...new Set(files.map((file) => path.resolve(cwd, toPath(file))))].filter(
    (filePath) => isPathInside(filePath, top),
  );
  const extraFilesByDirectory = Map.groupBy(extraFilePaths, (filePath) => path.dirname(filePath));
  // To read the files from `files` in the other directories after the search
  const searchedDirectories = new Set<string>();

  /** The files from `fileNames` that exist, then the ones from `files` */
  const getIgnoreFiles = (directoryPath: string, hasFile: (name: string) => boolean) => {
    searchedDirectories.add(directoryPath);
    const namedFiles = fileNames
      .filter(hasFile)
      .map((name) => ({path: path.join(directoryPath, name), followSymlinks: false}));
    const extraFiles = (extraFilesByDirectory.get(directoryPath) || [])
      .filter((filePath) => namedFiles.every((file) => file.path !== filePath))
      .map((filePath) => ({path: filePath, followSymlinks: true}));
    return [...namedFiles, ...extraFiles];
  };

  const gitEnvironment = getGitEnvironment(env);
  // Needed for `core.excludesFile` and `core.ignoreCase`
  const configPaths =
    repository && (excludesFile === true || options.ignoreCase == null)
      ? getConfigPaths(repository, gitEnvironment)
      : undefined;
  // Otherwise, it's found in the config
  const givenExcludesFilePath =
    repository && typeof excludesFile !== 'boolean'
      ? path.resolve(cwd, toPath(excludesFile))
      : undefined;
  const infoExcludePath =
    infoExclude && repository?.commonDirectory
      ? path.join(repository.commonDirectory, 'info', 'exclude')
      : undefined;
  const gitmodulesPath =
    submodules && repository ? path.join(repository.workTree, '.gitmodules') : undefined;
  const toRelative = (absolutePath: string) => toPosixPath(path.relative(base, absolutePath));
  const ancestorIgnoreFiles = searchedAncestors.flatMap((directory) =>
    getIgnoreFiles(directory, () => true).map((file) => ({
      ...file,
      directory: toRelative(directory),
    })),
  );

  // All at once, to read them concurrently in async mode
  const [
    mainConfigContents = [],
    [worktreeConfigContent] = [],
    [givenExcludesFileContent] = [],
    [infoExcludeContent] = [],
    [gitmodulesContent] = [],
    ancestorIgnoreFileContents = [],
  ] = yield* readFileGroups([
    (configPaths?.main || []).map((configPath) => ({path: configPath})),
    configPaths?.worktree == null ? [] : [{path: configPaths.worktree}],
    givenExcludesFilePath == null ? [] : [{path: givenExcludesFilePath}],
    infoExcludePath == null ? [] : [{path: infoExcludePath}],
    gitmodulesPath == null ? [] : [{path: gitmodulesPath, followSymlinks: false}],
    ancestorIgnoreFiles,
  ]);

  let configEntries: ConfigEntry[] = [];
  if (repository && configPaths) {
    configEntries = yield* readGitConfig(
      {
        main: configPaths.main.map((configPath, index) => ({
          path: configPath,
          content: mainConfigContents[index],
        })),
        ...(configPaths.worktree != null && {
          worktree: {path: configPaths.worktree, content: worktreeConfigContent},
        }),
      },
      gitEnvironment,
      {
        // Git tries the real path first
        gitDirectories: [...new Set([realGitDirectory, repository.gitDirectory])].filter(
          (gitDirectory) => gitDirectory != null,
        ),
        ...(head != null && {head}),
      },
    );
  }
  const isCaseInsensitive =
    options.ignoreCase ?? isTrueEntry(findConfigEntry(configEntries, 'core', 'ignorecase'));

  let excludesFilePath = givenExcludesFilePath;
  let excludesFileContent = givenExcludesFileContent;
  if (repository && excludesFile === true) {
    excludesFilePath = getExcludesFilePath(configEntries, gitEnvironment, repository.workTree);
    [excludesFileContent] =
      excludesFilePath == null ? [] : yield* readFiles([{path: excludesFilePath}]);
  }

  const builder = createGitignoreBuilder({
    cwd,
    ...(repository && {repository}),
    base,
    isCaseInsensitive,
  });

  if (excludesFilePath != null && excludesFileContent != null) {
    builder.addFile({
      type: 'excludes-file',
      filePath: excludesFilePath,
      directory: '',
      content: excludesFileContent,
    });
  }
  if (infoExcludePath != null && infoExcludeContent != null) {
    builder.addFile({
      type: 'info-exclude',
      filePath: infoExcludePath,
      directory: '',
      content: infoExcludeContent,
    });
  }
  const addIgnoreFiles = (
    ignoreFiles: readonly IgnoreFileInDirectory[],
    contents: readonly (string | undefined)[],
  ) => {
    ignoreFiles.forEach((file, index) => {
      const content = contents[index];
      if (content != null) {
        builder.addFile({
          type: 'ignore-file',
          filePath: file.path,
          directory: file.directory,
          content,
        });
      }
    });
  };
  addIgnoreFiles(ancestorIgnoreFiles, ancestorIgnoreFileContents);
  if (gitmodulesPath != null && gitmodulesContent != null) {
    getSubmodulePaths(gitmodulesContent).forEach((submodule) => {
      builder.addSeparateRepository({
        type: 'gitmodules',
        filePath: gitmodulesPath,
        directory: submodule.path,
        line: submodule.line,
      });
    });
  }

  if (nested) {
    yield* searchNestedIgnoreFiles({
      cwd,
      skippedNames: new Set([DOT_GIT, ...skipDirectories]),
      shouldIgnoreNestedRepositories: repository != null && nestedRepositories,
      toRelative,
      getIgnoreFiles,
      isDirectoryIgnored: builder.isDirectoryIgnored,
      addIgnoreFiles,
      addNestedRepository: (directory) => {
        builder.addSeparateRepository({type: 'nested-repositories', directory, line: 0});
      },
    });
  }

  const otherExtraFiles = extraFilePaths.flatMap((filePath) =>
    searchedDirectories.has(path.dirname(filePath))
      ? []
      : {path: filePath, followSymlinks: true, directory: toRelative(path.dirname(filePath))},
  );
  if (otherExtraFiles.length > 0) {
    addIgnoreFiles(otherExtraFiles, yield* readFiles(otherExtraFiles));
  }

  return builder.build();
}

/**
 * Reads gitignore rules for the directory from every source git reads them from.
 * Call it as a function (or `.async`) to read the files concurrently, or use `.sync`
 */
export const readGitignore = quansync(readGitignoreGenerator);

/** The same as `readGitignore.sync` */
export const readGitignoreSync = readGitignore.sync;
