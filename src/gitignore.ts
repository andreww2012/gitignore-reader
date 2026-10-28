import path from 'node:path';
import {mapGetOrInsert, mapGetOrInsertComputed} from '@andreww2012/unutils/map';
import {toEslintIgnores} from './eslint-ignores.ts';
import {getParentDirectory, getPathInDirectory, isPathInside, toPath, toPosixPath} from './path.ts';
import {
  type CompiledRule,
  type GitignoreRule,
  compileDirectoryRule,
  compileGitignore,
  fromByteString,
  normalizeCase,
  toByteString,
} from './pattern.ts';
import type {GitRepository} from './repository.ts';

export type GitignoreSourceType =
  /** The file set by git's `core.excludesFile` option, or its default, `~/.config/git/ignore` */
  | 'excludes-file'
  /** `$GIT_DIR/info/exclude` */
  | 'info-exclude'
  /** A `.gitignore` file, or another one from `sources.fileNames` or `sources.files` */
  | 'ignore-file'
  /** Submodules listed in `.gitmodules` */
  | 'gitmodules'
  /** Directories with their own `.git` directory or file, found during the search */
  | 'nested-repositories';

export interface GitignoreSource {
  type: GitignoreSourceType;
  /** Absolute path of the file the rules come from, absent for `nested-repositories` */
  path?: string;
  /** Absolute path of the directory the rules are relative to */
  directory: string;
  rules: GitignoreRule[];
}

export interface GitignoreCheckResult {
  ignored: boolean;

  /**
   * The rule that decided the outcome, which may be a negated one.
   * Absent if no rule matched
   */
  rule?: GitignoreRule;
  source?: GitignoreSource;
  /** Absolute path the rule matched: the checked path or the parent directory that is ignored */
  matchedPath?: string;
}

export interface Gitignore {
  /** Absolute path of the directory the rules were read for */
  cwd: string;
  /** Absent outside of a git repository */
  repository?: GitRepository;
  /** Whether paths are matched case-insensitively, see the `ignoreCase` option */
  ignoreCase: boolean;
  /** Every source of the rules, in the order of increasing precedence */
  sources: GitignoreSource[];

  /**
   * Tells if git would ignore the path.
   * A relative path is resolved against `cwd`.
   * Paths outside of the repository are never ignored.
   * Outside of a repository, the same goes for paths outside of `root`
   * @param path The path to check, absolute or relative to `cwd`
   * @param isDirectory Directory-only rules (like `dist/`) only match directories.
   * Defaults to `true` if the path ends with a path separator
   */
  isIgnored: (path: string | URL, isDirectory?: boolean) => boolean;
  /** Like `isIgnored`, but also tells why, like `git check-ignore --verbose` does */
  check: (path: string | URL, isDirectory?: boolean) => GitignoreCheckResult;

  /**
   * Converts the rules into patterns for ESLint's `ignores`, relative to `cwd`.
   * In ESLint, they mean what the rules mean in git, provided that its base path is `cwd`.
   * The only exception is names with non-ASCII characters: in them, `?` and `[...]` match
   * a single byte in git, but a whole character in ESLint.
   * Other tools apply ignore patterns differently, so use the matcher with them.
   * Rules that only matter for `cwd` itself or its parents are left out, i.e. it doesn't
   * matter if `cwd` is ignored itself.
   * The patterns are always case-sensitive, like ESLint itself, even if `ignoreCase` is on
   */
  toEslintIgnores: () => string[];
}

interface RuleLookup {
  /** The index of the last rule with the key */
  anyPath: Map<string, number>;
  /** The same for directory-only rules */
  directoryOnly: Map<string, number>;
}

/**
 * Most rules are just a name or an extension, so they are looked up instead of tested one by one.
 * The order of rules still matters, hence the indexes
 */
interface RuleLookups {
  byBasename: RuleLookup;
  byExtension: RuleLookup;
  /** Indexes of the other rules, in ascending order */
  others: number[];
}

interface Source {
  publicSource: GitignoreSource;
  /** Relative to the base directory, a byte string */
  directory: string;
  rules: CompiledRule[];
}

/** The rules of an ignore file, with lookups for the ones that are just a name or an extension */
interface FileSource extends Source {
  lookups: RuleLookups;
}

interface Match {
  source: Source;
  rule: GitignoreRule;
}

const createRuleLookup = (): RuleLookup => ({anyPath: new Map(), directoryOnly: new Map()});

const createRuleLookups = (rules: readonly CompiledRule[]) =>
  rules.reduce<RuleLookups>(
    (lookups, {rule, tokens, basename, extension}, ruleIndex) => {
      const key = basename || extension;
      if (key != null) {
        const lookup = basename == null ? lookups.byExtension : lookups.byBasename;
        (rule.directoryOnly ? lookup.directoryOnly : lookup.anyPath).set(key, ruleIndex);
      } else if (tokens) {
        lookups.others.push(ruleIndex);
      }
      return lookups;
    },
    {byBasename: createRuleLookup(), byExtension: createRuleLookup(), others: []},
  );

const lookUp = (lookup: RuleLookup, key: string | undefined, isDirectory: boolean) => {
  if (key == null) {
    return -1;
  }
  const ruleIndex = lookup.anyPath.get(key) ?? -1;
  return isDirectory ? Math.max(ruleIndex, lookup.directoryOnly.get(key) ?? -1) : ruleIndex;
};

/** Returns the index of the last matching rule or `-1` */
const findInSource = (
  {lookups, rules, directory}: FileSource,
  relativePath: string,
  basename: string,
  extension: string | undefined,
  isDirectory: boolean,
) => {
  const lastLookedUp = Math.max(
    lookUp(lookups.byBasename, basename, isDirectory),
    lookUp(lookups.byExtension, extension, isDirectory),
  );
  let pathInSource: string | undefined;
  for (let i = lookups.others.length - 1; i >= 0; i--) {
    const ruleIndex = lookups.others[i] ?? -1;
    const compiled = rules[ruleIndex];
    if (!compiled || ruleIndex < lastLookedUp) {
      break;
    }
    pathInSource ||= getPathInDirectory(relativePath, directory);
    if ((isDirectory || !compiled.rule.directoryOnly) && compiled.isMatch(pathInSource, basename)) {
      return ruleIndex;
    }
  }
  return lastLookedUp;
};

const hasTrailingSeparator = (value: string) => value.endsWith('/') || value.endsWith(path.sep);

/** A rule matched, and it isn't a negated one */
const isIgnoringMatch = (match: Match | null | undefined) => match != null && !match.rule.negated;

/** Matches a path with an empty, `.` or `..` segment */
const UNNORMALIZED_PATH_REGEX =
  path.sep === '\\' ? /(?:^|[/\\])\.{0,2}(?:[/\\]|$)/ : /(?:^|\/)\.{0,2}(?:\/|$)/;

interface GitignoreBuilderOptions {
  cwd: string;
  repository?: GitRepository;
  /** The directory relative paths are relative to: the working tree or the filesystem root */
  base: string;
  isCaseInsensitive: boolean;
}

/**
 * Collects the sources (in the order of increasing precedence) and matches paths against them.
 * Relative paths are matched as byte strings with the case normalized: the "keys" below
 */
export const createGitignoreBuilder = ({
  cwd,
  repository,
  base,
  isCaseInsensitive,
}: GitignoreBuilderOptions) => {
  const fileSources: FileSource[] = [];
  // `excludes-file` and `info-exclude`
  const baseSources: FileSource[] = [];
  // Keys are directory keys
  const sourcesByDirectory = new Map<string, FileSource[]>();
  // Submodules and nested repositories: their files belong to other repositories
  const separateRepositorySources = new Map<GitignoreSourceType, Source>();
  // Keys are directory keys
  const separateRepositories = new Map<string, Match>();

  const directoryCache = new Map<string, Match | null>();
  // The sources that apply to the paths in a directory, from the lowest precedence
  const applicableSourcesCache = new Map<string, readonly FileSource[]>();

  const toKey = (relativePath: string) =>
    normalizeCase(toByteString(relativePath), isCaseInsensitive);

  const getApplicableSources = (directoryKey: string): readonly FileSource[] =>
    mapGetOrInsertComputed(applicableSourcesCache, directoryKey, () => {
      const parentSources =
        directoryKey.length === 0
          ? baseSources
          : getApplicableSources(getParentDirectory(directoryKey));
      const ownSources = sourcesByDirectory.get(directoryKey);
      return ownSources ? [...parentSources, ...ownSources] : parentSources;
    });

  /** Doesn't check the parents */
  const findMatch = (key: string, isDirectory: boolean): Match | undefined => {
    if (isDirectory) {
      const separateRepository = separateRepositories.get(key);
      if (separateRepository) {
        return separateRepository;
      }
    }
    const basename = key.slice(key.lastIndexOf('/') + 1);
    const dotIndex = basename.lastIndexOf('.');
    const extension = dotIndex === -1 ? undefined : basename.slice(dotIndex);
    const sources = getApplicableSources(getParentDirectory(key));
    for (let i = sources.length - 1; i >= 0; i--) {
      const source = sources[i];
      const rule = source?.rules[findInSource(source, key, basename, extension, isDirectory)]?.rule;
      if (source && rule) {
        return {source, rule};
      }
    }
    return undefined;
  };

  const findDirectoryMatch = (key: string) => findMatch(key, true) || null;

  const matchDirectory = (key: string) =>
    mapGetOrInsertComputed(directoryCache, key, findDirectoryMatch);

  /** Checks the parents too */
  const checkKey = (key: string, isDirectory: boolean) => {
    for (
      let slashIndex = key.indexOf('/');
      slashIndex >= 0;
      slashIndex = key.indexOf('/', slashIndex + 1)
    ) {
      const match = matchDirectory(key.slice(0, slashIndex));
      if (match && isIgnoringMatch(match)) {
        return {match, matchedLength: slashIndex};
      }
    }
    const match = isDirectory ? matchDirectory(key) : findMatch(key, false);
    return match ? {match, matchedLength: key.length} : undefined;
  };

  const basePrefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const cwdDirectory = toPosixPath(path.relative(base, cwd));
  const cwdPrefix = cwdDirectory.length === 0 ? '' : `${cwdDirectory}/`;

  const toRelative = (inputPath: string) => {
    const trimmedPath = hasTrailingSeparator(inputPath) ? inputPath.slice(0, -1) : inputPath;
    // `path.resolve` and `path.relative` take much more time than matching itself
    if (path.isAbsolute(trimmedPath)) {
      const relativePath = trimmedPath.startsWith(basePrefix)
        ? trimmedPath.slice(basePrefix.length)
        : '';
      if (relativePath.length > 0 && !UNNORMALIZED_PATH_REGEX.test(relativePath)) {
        return toPosixPath(relativePath);
      }
    } else if (trimmedPath.length > 0 && !UNNORMALIZED_PATH_REGEX.test(trimmedPath)) {
      return `${cwdPrefix}${toPosixPath(trimmedPath)}`;
    }
    const absolutePath = path.resolve(cwd, inputPath);
    const relativePath = toPosixPath(path.relative(base, absolutePath));
    return isPathInside(absolutePath, base) && relativePath.length > 0 ? relativePath : undefined;
  };

  /** Also returns the relative path as a byte string, to report the matched path */
  const checkPath = (value: string | URL, isDirectory: boolean | undefined) => {
    const inputPath = toPath(value);
    const relativePath = toRelative(inputPath);
    if (relativePath == null) {
      return undefined;
    }
    const pathBytes = toByteString(relativePath);
    const result = checkKey(
      normalizeCase(pathBytes, isCaseInsensitive),
      isDirectory ?? hasTrailingSeparator(inputPath),
    );
    return result && {...result, pathBytes};
  };

  const getSources = () => [...fileSources, ...separateRepositorySources.values()];

  let eslintIgnores: string[] | undefined;

  return {
    /** Adds the rules of a file, `directory` is the relative path of the file's directory */
    addFile: ({
      type,
      filePath,
      directory,
      content,
    }: {
      type: Exclude<GitignoreSourceType, 'gitmodules' | 'nested-repositories'>;
      filePath: string;
      directory: string;
      content: string;
    }) => {
      const rules = compileGitignore(content, isCaseInsensitive);
      const source: FileSource = {
        publicSource: {
          type,
          path: filePath,
          directory: path.join(base, directory),
          rules: rules.map(({rule}) => rule),
        },
        directory: toByteString(directory),
        rules,
        lookups: createRuleLookups(rules),
      };
      fileSources.push(source);
      if (type === 'ignore-file') {
        const key = toKey(directory);
        mapGetOrInsert(sourcesByDirectory, key, []).push(source);
      } else {
        baseSources.push(source);
      }
    },

    /**
     * Ignores the directory of a submodule or a nested repository regardless of the rules.
     * Its sources go after all the others, since nothing can re-include their contents
     */
    addSeparateRepository: ({
      type,
      filePath,
      directory,
      line,
    }: {
      type: Extract<GitignoreSourceType, 'gitmodules' | 'nested-repositories'>;
      filePath?: string;
      directory: string;
      line: number;
    }) => {
      let source = separateRepositorySources.get(type);
      if (!source) {
        source = {
          publicSource: {
            type,
            ...(filePath != null && {path: filePath}),
            directory: base,
            rules: [],
          },
          directory: '',
          rules: [],
        };
        separateRepositorySources.set(type, source);
      }
      const compiled = compileDirectoryRule(directory, line, isCaseInsensitive);
      source.rules.push(compiled);
      source.publicSource.rules.push(compiled.rule);
      const key = toKey(directory);
      const match = {source, rule: compiled.rule};
      separateRepositories.set(key, match);
      directoryCache.set(key, match);
    },

    /** For the search of nested ignore files, which already knows the parents aren't ignored */
    isDirectoryIgnored: (relativePath: string) =>
      isIgnoringMatch(matchDirectory(toKey(relativePath))),

    /** Call it once all the sources are added */
    build: (): Gitignore => ({
      cwd,
      ...(repository && {repository}),
      ignoreCase: isCaseInsensitive,
      sources: getSources().map((source) => source.publicSource),
      isIgnored: (value, isDirectory) => isIgnoringMatch(checkPath(value, isDirectory)?.match),
      check: (value, isDirectory) => {
        const result = checkPath(value, isDirectory);
        if (!result) {
          return {ignored: false};
        }
        return {
          ignored: !result.match.rule.negated,
          rule: result.match.rule,
          source: result.match.source.publicSource,
          matchedPath: path.join(
            base,
            fromByteString(result.pathBytes.slice(0, result.matchedLength)),
          ),
        };
      },
      toEslintIgnores: () => {
        eslintIgnores ||= toEslintIgnores(
          getSources(),
          toByteString(cwdDirectory),
          isCaseInsensitive,
        );
        return [...eslintIgnores];
      },
    }),
  };
};
