// A small reader of git config files: just enough to find `core.excludesFile` the way git does,
// including `include.path` and `includeIf` (`gitdir:`, `gitdir/i:` and `onbranch:` conditions)
import path from 'node:path';
import type {QuansyncGenerator} from 'quansync';
import {getRealPaths, readFiles} from './fs.ts';
import {toPosixPath} from './path.ts';
import {createConditionMatcher, normalizeCase} from './pattern.ts';

export interface ConfigEntry {
  /** Lowercased */
  section: string;
  /** Case-sensitive, unless the deprecated `[section.subsection]` syntax is used */
  subsection?: string;
  /** Lowercased */
  key: string;
  /** Absent for a key without `=`, which means `true` */
  value?: string;
  line: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

interface ConfigContext {
  home: string;

  /**
   * The real path of the git directory and the one it was found by, if they differ.
   * Git tries both for `includeIf "gitdir:..."`
   */
  gitDirectories: readonly string[];
  branch?: string;
}

// Git's limit too
const MAX_INCLUDE_DEPTH = 10;

const BOM = '\u{FEFF}';

// Only these are spaces for git, unlike `\v` and `\f`
const SPACE_REGEX = /[\t\n\r ]/;
const ALPHA_REGEX = /[a-z]/i;
const KEY_CHAR_REGEX = /[\d\-a-z]/i;
const INCLUDE_CONDITION_REGEX = /^(gitdir|gitdir\/i|onbranch):(.*)$/s;
const TRUE_REGEX = /^(?:true|yes|on)$/i;
// A git integer: decimal, hexadecimal (`0x10`) or octal (`010`), with an optional unit (`1k`)
const INTEGER_REGEX = /^[\t\n\v\f\r ]*[+-]?(0x[\da-f]+|0[0-7]*|[1-9]\d*)[gkm]?$/i;
const NON_ZERO_DIGIT_REGEX = /[1-9a-f]/i;
const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-z]:\//i;

/** The end of the content is an empty string, and it ends a line too */
const isLineEnd = (char: string) => char === '\n' || char.length === 0;

const ESCAPED_VALUE_CHARS: Readonly<Record<string, string>> = Object.freeze({
  '\\': '\\',
  '"': '"',
  b: '\b',
  n: '\n',
  t: '\t',
});

/**
 * Parses a git config file exactly like git does.
 * A syntax error makes git fail, here it just stops the parsing
 */
export const parseGitConfig = (content: string) => {
  const entries: ConfigEntry[] = [];
  let i = content.startsWith(BOM) ? BOM.length : 0;
  let line = 1;

  /**
   * Turns `\r\n` into `\n`, like git.
   * Returns an empty string at the end, which ends a line too
   */
  const next = () => {
    let char = content.charAt(i++);
    if (char === '\r' && content.charAt(i) === '\n') {
      char = '\n';
      i++;
    }
    if (char === '\n') {
      line++;
    }
    return char;
  };

  /** Reads `"subsection"]` after the spaces */
  const parseSubsection = (firstSpace: string) => {
    let char = firstSpace;
    while (SPACE_REGEX.test(char)) {
      if (char === '\n') {
        return undefined;
      }
      char = next();
    }
    if (char !== '"') {
      return undefined;
    }
    let subsection = '';
    while (true) {
      char = next();
      if (char === '"') {
        return next() === ']' ? subsection : undefined;
      }
      // Backslashes are dropped
      if (char === '\\') {
        char = next();
      }
      if (isLineEnd(char)) {
        return undefined;
      }
      subsection += char;
    }
  };

  /**
   * Returns the section name with the subsection after a dot.
   * The section is lowercased, and so is the subsection in the deprecated `[section.subsection]`
   */
  const parseSectionHeader = () => {
    let name = '';
    while (true) {
      const char = next();
      if (char === ']') {
        return name;
      }
      if (SPACE_REGEX.test(char)) {
        const subsection = parseSubsection(char);
        return subsection == null ? undefined : `${name}.${subsection}`;
      }
      if (char !== '.' && !KEY_CHAR_REGEX.test(char)) {
        return undefined;
      }
      name += char.toLowerCase();
    }
  };

  /** Git keeps the spaces inside a value, but not around it */
  const parseValue = () => {
    let value = '';
    // The length of the value without the trailing spaces, if there are any
    let trimmedLength = 0;
    let isQuoted = false;
    let isComment = false;
    for (let char = next(); !isLineEnd(char); char = next()) {
      if (isComment) {
        continue;
      }
      if (!isQuoted && SPACE_REGEX.test(char)) {
        trimmedLength ||= value.length;
        if (value.length > 0) {
          value += char;
        }
        continue;
      }
      if (!isQuoted && (char === ';' || char === '#')) {
        isComment = true;
        continue;
      }
      trimmedLength = 0;
      if (char === '"') {
        isQuoted = !isQuoted;
      } else if (char === '\\') {
        const escapedChar = next();
        // Otherwise, the value continues on the next line
        if (!isLineEnd(escapedChar)) {
          const escaped = ESCAPED_VALUE_CHARS[escapedChar];
          if (escaped == null) {
            return undefined;
          }
          value += escaped;
        }
      } else {
        value += char;
      }
    }
    if (isQuoted) {
      return undefined;
    }
    return trimmedLength > 0 ? value.slice(0, trimmedLength) : value;
  };

  /** Returns `undefined` on a syntax error */
  const parseEntry = (firstChar: string) => {
    const keyLine = line;
    let key = firstChar.toLowerCase();
    let char = next();
    while (KEY_CHAR_REGEX.test(char)) {
      key += char.toLowerCase();
      char = next();
    }
    while (char === ' ' || char === '\t') {
      char = next();
    }
    if (isLineEnd(char)) {
      return {key, line: keyLine};
    }
    if (char !== '=') {
      return undefined;
    }
    const value = parseValue();
    return value == null ? undefined : {key, value, line: keyLine};
  };

  let sectionName: string | undefined;
  let isComment = false;
  for (let char = next(); char.length > 0; char = next()) {
    if (char === '\n') {
      isComment = false;
      continue;
    }
    if (isComment || SPACE_REGEX.test(char)) {
      continue;
    }
    if (char === '#' || char === ';') {
      isComment = true;
      continue;
    }
    if (char === '[') {
      sectionName = parseSectionHeader();
      if (!sectionName) {
        return entries;
      }
      continue;
    }
    const entry = ALPHA_REGEX.test(char) ? parseEntry(char) : undefined;
    if (!entry) {
      return entries;
    }
    // Entries before the first section don't count
    if (sectionName == null) {
      continue;
    }
    const dotIndex = sectionName.indexOf('.');
    entries.push({
      ...(dotIndex === -1
        ? {section: sectionName}
        : {section: sectionName.slice(0, dotIndex), subsection: sectionName.slice(dotIndex + 1)}),
      ...entry,
    });
  }
  return entries;
};

/** Expands `~/` and makes the path absolute */
export const resolveConfigPath = (value: string, home: string, relativeTo: string) => {
  if (value === '~') {
    return home;
  }
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(relativeTo, value);
};

// Makes a `gitdir:` pattern absolute, like git: `~/` is the real path of the home directory, `./`
// is the directory of the real path of the config file (matched literally: it's the returned
// prefix), and other relative patterns match at any depth
function* prepareGitDirectoryPattern(
  rawPattern: string,
  configFilePath: string,
  home: string,
): QuansyncGenerator<{prefix: string; pattern: string}> {
  let pattern = toPosixPath(rawPattern);
  let prefix = '';
  if (pattern === '~' || pattern.startsWith('~/')) {
    const [realHome = home] = yield* getRealPaths([home]);
    pattern = `${toPosixPath(realHome)}${pattern.slice(1)}`;
  } else if (pattern.startsWith('./')) {
    const [realConfigFilePath = configFilePath] = yield* getRealPaths([configFilePath]);
    prefix = `${toPosixPath(path.dirname(realConfigFilePath))}/`;
    pattern = pattern.slice(2);
  } else if (!pattern.startsWith('/') && !WINDOWS_ABSOLUTE_PATH_REGEX.test(pattern)) {
    pattern = `**/${pattern}`;
  }
  // `./` alone ends with a slash too
  return {prefix, pattern: `${prefix}${pattern}`.endsWith('/') ? `${pattern}**` : pattern};
}

function* evaluateCondition(
  condition: string,
  configFilePath: string,
  context: ConfigContext,
): QuansyncGenerator<boolean> {
  const [, type, rawPattern = ''] = INCLUDE_CONDITION_REGEX.exec(condition) || [];
  if (type === 'onbranch') {
    return (
      context.branch != null &&
      createConditionMatcher(
        rawPattern.endsWith('/') ? `${rawPattern}**` : rawPattern,
        false,
      )(context.branch)
    );
  }
  if (type == null) {
    return false;
  }
  const isCaseInsensitive = type === 'gitdir/i';
  const {prefix, pattern} = yield* prepareGitDirectoryPattern(
    rawPattern,
    configFilePath,
    context.home,
  );
  const normalizedPrefix = normalizeCase(prefix, isCaseInsensitive);
  const isMatch = createConditionMatcher(pattern, isCaseInsensitive);
  return context.gitDirectories.some((gitDirectory) => {
    const posixGitDirectory = toPosixPath(gitDirectory);
    return (
      normalizeCase(posixGitDirectory.slice(0, prefix.length), isCaseInsensitive) ===
        normalizedPrefix && isMatch(posixGitDirectory.slice(prefix.length))
    );
  });
}

function* getIncludedPath(
  entry: ConfigEntry,
  filePath: string,
  context: ConfigContext,
  depth: number,
): QuansyncGenerator<string | undefined> {
  if (entry.key !== 'path' || entry.value == null || depth >= MAX_INCLUDE_DEPTH) {
    return undefined;
  }
  const isInclude =
    (entry.section === 'include' && entry.subsection == null) ||
    (entry.section === 'includeif' &&
      entry.subsection != null &&
      (yield* evaluateCondition(entry.subsection, filePath, context)));
  return isInclude
    ? resolveConfigPath(entry.value, context.home, path.dirname(filePath))
    : undefined;
}

function* expandIncludes(
  entries: ConfigEntry[],
  filePath: string,
  context: ConfigContext,
  depth: number,
): QuansyncGenerator<ConfigEntry[]> {
  const result: ConfigEntry[] = [];
  for (const entry of entries) {
    result.push(entry);
    const includedPath = yield* getIncludedPath(entry, filePath, context, depth);
    if (includedPath == null) {
      continue;
    }
    const [content] = yield* readFiles([{path: includedPath}]);
    if (content != null) {
      result.push(
        ...(yield* expandIncludes(parseGitConfig(content), includedPath, context, depth + 1)),
      );
    }
  }
  return result;
}

// Parses the already read config files and reads their includes one by one
export function* expandGitConfigFiles(
  files: readonly {path: string; content: string | undefined}[],
  context: ConfigContext,
): QuansyncGenerator<ConfigEntry[]> {
  const result: ConfigEntry[] = [];
  for (const file of files) {
    if (file.content != null) {
      result.push(...(yield* expandIncludes(parseGitConfig(file.content), file.path, context, 0)));
    }
  }
  return result;
}

/** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` */
export const getEnvironmentConfig = (env: Env) =>
  Array.from({length: Number(env.GIT_CONFIG_COUNT) || 0}, (_, index): ConfigEntry[] => {
    const name = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    const firstDotIndex = name?.indexOf('.') ?? -1;
    const lastDotIndex = name?.lastIndexOf('.') ?? -1;
    if (name == null || firstDotIndex === -1) {
      return [];
    }
    return [
      {
        section: name.slice(0, firstDotIndex).toLowerCase(),
        ...(firstDotIndex < lastDotIndex && {
          subsection: name.slice(firstDotIndex + 1, lastDotIndex),
        }),
        key: name.slice(lastDotIndex + 1).toLowerCase(),
        ...(value != null && {value}),
        line: 0,
      },
    ];
  }).flat();

/**
 * Whether git reads the value as `true`.
 * An invalid value is an error for git, here it's `false`
 */
export const isTruthyGitValue = (value: string | undefined) =>
  value != null &&
  (TRUE_REGEX.test(value) || NON_ZERO_DIGIT_REGEX.test(INTEGER_REGEX.exec(value)?.[1] || ''));

/** A key without a value means `true` */
export const isTrueEntry = (entry: ConfigEntry | undefined) =>
  entry != null && (entry.value == null || isTruthyGitValue(entry.value));

/** The last entry with the key, outside of subsections */
export const findConfigEntry = (entries: readonly ConfigEntry[], section: string, key: string) =>
  entries.findLast(
    (entry) => entry.section === section && entry.subsection == null && entry.key === key,
  );
