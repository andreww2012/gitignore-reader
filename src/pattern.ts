// Parses and matches gitignore patterns exactly like git does, including the quirks that its
// documentation doesn't mention

// cspell:ignore cntrl

export interface GitignoreRule {
  /** The pattern as git sees it: the trailing spaces it ignores are already removed */
  pattern: string;
  /** 1-based line number in the source file, `0` for rules that don't come from a line of a file */
  line: number;
  /** Starts with `!`, so it re-includes the paths it matches */
  negated: boolean;
  /** Ends with `/`, so it only matches directories */
  directoryOnly: boolean;

  /**
   * Has a slash at the beginning or in the middle.
   * Such a rule is matched against the path relative to the directory of its source,
   * others are matched against the last path component only
   */
  anchored: boolean;
}

/** Bytes, both inclusive */
export type ClassRange = readonly [from: number, to: number];

/**
 * A single byte (written as a range of one) or a range.
 * The difference matters when git ignores case
 */
type ClassMember = readonly [from: number, to: number, isRange: boolean];

/** Literals are single characters of a byte string */
export type Token =
  // Git ignores the case of escaped characters differently
  | {type: 'literal'; value: string; isEscaped?: boolean}
  | {type: 'stars'; count: number}
  | {type: 'any'}
  | {type: 'class'; negated: boolean; members: ClassMember[]};

/** A rule ready for matching and for conversion to globs */
export interface CompiledRule {
  rule: GitignoreRule;
  /** Absent if the rule can never match (git ignores such patterns silently) */
  tokens?: Token[];

  /**
   * Receives a path relative to the directory of the rule's source and its last component, both
   * as byte strings with the case normalized
   */
  isMatch: (relativePath: string, basename: string) => boolean;

  /**
   * Set if the rule matches exactly the paths with this last component, like `node_modules`.
   * A byte string with the case normalized
   */
  basename?: string;

  /**
   * Set if the rule matches exactly the paths with this extension (including the dot), like
   * `*.log`.
   * A byte string with the case normalized
   */
  extension?: string;
}

export const SLASH = '/';
export const SLASH_CODE = 0x2f;
const UPPERCASE_A_CODE = 0x41;
const UPPERCASE_Z_CODE = 0x5a;
// The distance between an uppercase ASCII letter and its lowercase version
const LOWERCASE_OFFSET = 0x20;
const BOM = '\u{FEFF}';

export const SLASH_TOKEN: Token = Object.freeze({type: 'literal', value: SLASH});
const STAR_TOKEN: Token = Object.freeze({type: 'stars', count: 1});

// ASCII only, like in git
const POSIX_CLASSES: Readonly<Record<string, readonly ClassRange[]>> = Object.freeze({
  // 0-9, A-Z, a-z
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  // Tab and space
  blank: [
    [0x09, 0x09],
    [0x20, 0x20],
  ],
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f],
  ],
  digit: [[0x30, 0x39]],
  graph: [[0x21, 0x7e]],
  lower: [[0x61, 0x7a]],
  print: [[0x20, 0x7e]],
  punct: [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
  ],
  // `\t\n\v\f\r` and space
  space: [
    [0x09, 0x0d],
    [0x20, 0x20],
  ],
  upper: [[0x41, 0x5a]],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66],
  ],
});

const NON_ASCII_REGEX = /\P{ASCII}/u;
const ASCII_UPPERCASE_REGEX = /[A-Z]/g;
const EXTENSION_REGEX = /^\.[^.]*$/;
const GITIGNORE_SPECIAL_CHARS_REGEX = /[*?[\\]/g;
const GITIGNORE_SPECIAL_FIRST_CHAR_REGEX = /^[!#]/;

const isNeverMatching = () => false;

const toCode = (char: string) => char.codePointAt(0) || 0;

/**
 * Git matches bytes: `?` matches a single byte of `é`, for example.
 * That's why paths and patterns are matched as byte strings, which have a character for each byte
 * of the UTF-8 encoding
 */
export const toByteString = (value: string) =>
  NON_ASCII_REGEX.test(value) ? Buffer.from(value).toString('latin1') : value;

/** The reverse of `toByteString` */
export const fromByteString = (value: string) =>
  NON_ASCII_REGEX.test(value) ? Buffer.from(value, 'latin1').toString() : value;

/**
 * Git only folds the case of ASCII letters (with `core.ignoreCase`), unlike `String#toLowerCase`
 */
export const normalizeCase = (value: string, isCaseInsensitive: boolean) =>
  isCaseInsensitive ? value.replaceAll(ASCII_UPPERCASE_REGEX, (char) => char.toLowerCase()) : value;

export const formatRange = (from: number, to: number, formatChar: (code: number) => string) =>
  from === to ? formatChar(from) : `${formatChar(from)}-${formatChar(to)}`;

/** Removes unescaped trailing spaces, like git */
const trimTrailingSpaces = (line: string) => {
  let lastSpaceIndex = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === ' ') {
      if (lastSpaceIndex === -1) {
        lastSpaceIndex = i;
      }
    } else {
      if (char === '\\') {
        i++;
        if (i >= line.length) {
          return line;
        }
      }
      lastSpaceIndex = -1;
    }
  }
  return lastSpaceIndex === -1 ? line : line.slice(0, lastSpaceIndex);
};

/**
 * Parses a bracket expression starting right after `[`, like git.
 * `charAt` returns an empty string past the end of the pattern.
 * Returns `undefined` if the whole pattern can never match because of it
 */
const parseClass = (pattern: string, start: number) => {
  let i = start;
  const isNegated = pattern.charAt(i) === '!' || pattern.charAt(i) === '^';
  if (isNegated) {
    i++;
  }
  const members: ClassMember[] = [];
  // A byte that may start a range
  let previous: number | undefined;
  do {
    const char = pattern.charAt(i);
    if (char.length === 0) {
      return undefined;
    }
    const next = pattern.charAt(i + 1);
    if (char === '\\') {
      if (next.length === 0) {
        return undefined;
      }
      previous = toCode(next);
      members.push([previous, previous, false]);
      i++;
    } else if (char === '-' && previous != null && next !== ']' && next.length > 0) {
      i++;
      if (next === '\\') {
        i++;
      }
      const to = pattern.charAt(i);
      if (to.length === 0) {
        return undefined;
      }
      // The start was added as a single byte, which still matches if the range is empty
      if (previous <= toCode(to)) {
        members.pop();
        members.push([previous, toCode(to), true]);
      }
      previous = undefined;
    } else if (char === '[' && next === ':') {
      // The `]` of `:]`
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        return undefined;
      }
      if (end - (i + 2) < 1 || pattern.charAt(end - 1) !== ':') {
        // Not a character class name, so `[` is just a byte
        previous = toCode(char);
        members.push([previous, previous, false]);
      } else {
        const posixRanges = POSIX_CLASSES[pattern.slice(i + 2, end - 1)];
        if (!posixRanges) {
          return undefined;
        }
        members.push(...posixRanges.map(([from, to]): ClassMember => [from, to, true]));
        previous = undefined;
        i = end;
      }
    } else {
      previous = toCode(char);
      members.push([previous, previous, false]);
    }
    i++;
  } while (pattern.charAt(i) !== ']');
  return {token: {type: 'class', negated: isNegated, members} satisfies Token, end: i + 1};
};

/** Reads the token at the index, returns `undefined` if the whole pattern can never match */
const readToken = (pattern: string, index: number): {token: Token; end: number} | undefined => {
  const char = pattern.charAt(index);
  switch (char) {
    case '\\': {
      const escaped = pattern.charAt(index + 1);
      return escaped.length === 0
        ? undefined
        : {token: {type: 'literal', value: escaped, isEscaped: true}, end: index + 2};
    }
    case '*': {
      let end = index;
      while (pattern.charAt(end) === '*') {
        end++;
      }
      return {token: {type: 'stars', count: end - index}, end};
    }
    case '?': {
      return {token: {type: 'any'}, end: index + 1};
    }
    case '[': {
      return parseClass(pattern, index + 1);
    }
    default: {
      return {token: {type: 'literal', value: char}, end: index + 1};
    }
  }
};

/** Escaped or not */
export const isSlash = (token: Token | undefined) =>
  token?.type === 'literal' && token.value === SLASH;

const isEscapedSlash = (token: Token | undefined) =>
  token?.type === 'literal' && token.value === SLASH && token.isEscaped === true;

/** `**` is only special as a whole path segment, otherwise it's the same as `*` */
export const isGlobstar = (tokens: readonly Token[], index: number) => {
  const token = tokens[index];
  return (
    token?.type === 'stars' &&
    token.count > 1 &&
    (index === 0 || isSlash(tokens[index - 1])) &&
    (index === tokens.length - 1 || isSlash(tokens[index + 1]))
  );
};

/**
 * Before an escaped slash, `**` can't match zero directories, since git only checks for a plain
 * slash.
 * So `**\/` is replaced with `*`, `/**` and `/`, which need no special handling anywhere
 */
const expandGlobstarBeforeEscapedSlash = (tokens: readonly Token[]) =>
  tokens.flatMap((token, index): Token | Token[] => {
    if (isGlobstar(tokens, index) && isEscapedSlash(tokens[index + 1])) {
      return [STAR_TOKEN, SLASH_TOKEN, token];
    }
    return isEscapedSlash(token) && isGlobstar(tokens, index - 1) ? SLASH_TOKEN : token;
  });

/** Expects a byte string, returns `undefined` for a pattern that can never match */
const tokenize = (pattern: string) => {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length;) {
    const read = readToken(pattern, i);
    if (!read) {
      return undefined;
    }
    tokens.push(read.token);
    i = read.end;
  }
  return expandGlobstarBeforeEscapedSlash(tokens);
};

/**
 * Paths never have empty segments, so a pattern with one never matches, like `/` alone or `a//b`.
 * The check matters for the ESLint patterns: minimatch would ignore the extra slashes
 */
const hasEmptySegment = (tokens: readonly Token[]) =>
  tokens.length === 0 ||
  isSlash(tokens[0]) ||
  isSlash(tokens.at(-1)) ||
  tokens.some((token, index) => isSlash(token) && isSlash(tokens[index + 1]));

const toRegexChar = (code: number) => String.raw`\u{${code.toString(16)}}`;

/**
 * When git ignores case, it still compares an escaped character as is, so an escaped uppercase
 * letter never matches
 */
const getLiteralValue = (token: Extract<Token, {type: 'literal'}>, isCaseInsensitive: boolean) =>
  token.isEscaped ? token.value : normalizeCase(token.value, isCaseInsensitive);

/**
 * When git ignores case, it still compares the single bytes of a class as is, but a lowercase
 * letter also matches a range with its uppercase version in it
 */
const toRegexClass = (
  {negated, members}: Extract<Token, {type: 'class'}>,
  isCaseInsensitive: boolean,
) => {
  const text = members
    .flatMap(([from, to, isRange]): ClassRange[] => {
      if (from > to) {
        return [];
      }
      const uppercaseFrom = Math.max(from, UPPERCASE_A_CODE);
      const uppercaseTo = Math.min(to, UPPERCASE_Z_CODE);
      return isCaseInsensitive && isRange && uppercaseFrom <= uppercaseTo
        ? [
            [from, to],
            [uppercaseFrom + LOWERCASE_OFFSET, uppercaseTo + LOWERCASE_OFFSET],
          ]
        : [[from, to]];
    })
    .map(([from, to]) => formatRange(from, to, toRegexChar))
    .join('');
  return negated ? `[^/${text}]` : `(?!/)[${text}]`;
};

/** If case-insensitive, the regex expects paths with the case normalized */
const toRegexSource = (tokens: readonly Token[], isCaseInsensitive: boolean) => {
  const source = tokens
    .map((token, index) => {
      // The slash after `**` is already part of its regex
      if (isGlobstar(tokens, index - 1)) {
        return '';
      }
      if (token.type === 'literal') {
        return toRegexChar(toCode(getLiteralValue(token, isCaseInsensitive)));
      }
      if (token.type === 'any') {
        return '[^/]';
      }
      if (token.type === 'class') {
        return toRegexClass(token, isCaseInsensitive);
      }
      if (!isGlobstar(tokens, index)) {
        return '[^/]*';
      }
      // `**/` also matches nothing
      return index === tokens.length - 1 ? '.*' : '(?:.*/)?';
    })
    .join('');
  return `^${source}$`;
};

const getLiteral = (tokens: readonly Token[], isCaseInsensitive: boolean) =>
  tokens.every((token) => token.type === 'literal')
    ? tokens.map((token) => getLiteralValue(token, isCaseInsensitive)).join('')
    : undefined;

/** The returned function expects byte strings, with the case normalized if case-insensitive */
export const compileTokens = (tokens: readonly Token[], isCaseInsensitive: boolean) => {
  const literal = getLiteral(tokens, isCaseInsensitive);
  if (literal != null) {
    return (value: string) => value === literal;
  }
  const regex = new RegExp(toRegexSource(tokens, isCaseInsensitive), 'u');
  return (value: string) => regex.test(value);
};

/** Matches like the patterns of `includeIf` conditions, where only `**` matches slashes */
export const createConditionMatcher = (pattern: string, isCaseInsensitive: boolean) => {
  const tokens = tokenize(toByteString(pattern));
  if (!tokens) {
    return isNeverMatching;
  }
  const isMatch = compileTokens(tokens, isCaseInsensitive);
  return (value: string) => isMatch(normalizeCase(toByteString(value), isCaseInsensitive));
};

const compileMatching = (
  {anchored}: GitignoreRule,
  tokens: readonly Token[],
  isCaseInsensitive: boolean,
): Pick<CompiledRule, 'basename' | 'extension' | 'isMatch'> => {
  if (anchored) {
    return {isMatch: compileTokens(tokens, isCaseInsensitive)};
  }
  const basename = getLiteral(tokens, isCaseInsensitive);
  if (basename != null) {
    return {isMatch: (_relativePath, name) => name === basename, basename};
  }
  // `*.log` and the like, very common
  const suffix =
    tokens[0]?.type === 'stars' ? getLiteral(tokens.slice(1), isCaseInsensitive) : undefined;
  if (suffix != null) {
    return {
      isMatch: (_relativePath, name) => name.endsWith(suffix),
      ...(EXTENSION_REGEX.test(suffix) && {extension: suffix}),
    };
  }
  const isMatch = compileTokens(tokens, isCaseInsensitive);
  return {isMatch: (_relativePath, name) => isMatch(name)};
};

/** Parses a gitignore rule, or returns `undefined` for an empty line or a comment */
const parseRule = (rawLine: string, line: number) => {
  if (rawLine.length === 0 || rawLine.startsWith('#')) {
    return undefined;
  }
  const pattern = trimTrailingSpaces(rawLine);
  if (pattern.length === 0) {
    return undefined;
  }
  const isNegated = pattern.startsWith('!');
  const isDirectoryOnly = pattern.endsWith(SLASH);
  const body = pattern.slice(isNegated ? 1 : 0, isDirectoryOnly ? -1 : undefined);
  // Escaped slashes count too, as in git
  const isAnchored = body.includes(SLASH);
  return {
    rule: {
      pattern,
      line,
      negated: isNegated,
      directoryOnly: isDirectoryOnly,
      anchored: isAnchored,
    } satisfies GitignoreRule,
    body: body.startsWith(SLASH) ? body.slice(1) : body,
  };
};

/** Like git, strips `\r` at the end of every line, even the last one */
const splitLines = (content: string) =>
  (content.startsWith(BOM) ? content.slice(BOM.length) : content)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

export const compileGitignore = (content: string, isCaseInsensitive: boolean): CompiledRule[] =>
  splitLines(content).flatMap((rawLine, index) => {
    const parsed = parseRule(rawLine, index + 1);
    if (!parsed) {
      return [];
    }
    const tokens = tokenize(toByteString(parsed.body));
    return tokens && !hasEmptySegment(tokens)
      ? {rule: parsed.rule, tokens, ...compileMatching(parsed.rule, tokens, isCaseInsensitive)}
      : {rule: parsed.rule, isMatch: isNeverMatching};
  });

const toGitignoreLiteral = (value: string) => {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === ' ') {
    end--;
  }
  return `${value
    .slice(0, end)
    .replaceAll(GITIGNORE_SPECIAL_CHARS_REGEX, String.raw`\$&`)
    .replace(
      GITIGNORE_SPECIAL_FIRST_CHAR_REGEX,
      String.raw`\$&`,
    )}${String.raw`\ `.repeat(value.length - end)}`;
};

/** Makes a rule matching exactly the given directory, relative to the source directory */
export const compileDirectoryRule = (
  path: string,
  line: number,
  isCaseInsensitive: boolean,
): CompiledRule => {
  const pathBytes = toByteString(path);
  const expected = normalizeCase(pathBytes, isCaseInsensitive);
  return {
    rule: {
      pattern: `/${toGitignoreLiteral(path)}/`,
      line,
      negated: false,
      directoryOnly: true,
      anchored: true,
    },
    tokens: Array.from(pathBytes, (value): Token => ({type: 'literal', value})),
    isMatch: (relativePath) => relativePath === expected,
  };
};
