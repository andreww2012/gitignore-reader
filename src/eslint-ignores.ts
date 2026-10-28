// Conversion of the rules into patterns for ESLint's `ignores`, which it matches with minimatch.
// Paths and tokens are byte strings here (see `toByteString`), the patterns are decoded at the end
import {getPathInDirectory, isInsideDirectory} from './path.ts';
import {
  type ClassRange,
  type CompiledRule,
  SLASH,
  SLASH_CODE,
  SLASH_TOKEN,
  type Token,
  compileTokens,
  formatRange,
  fromByteString,
  isGlobstar,
  isSlash,
  normalizeCase,
} from './pattern.ts';

interface EslintIgnoresSource {
  /** Relative to the base directory, a byte string */
  directory: string;
  rules: readonly CompiledRule[];
}

const MAX_ASCII_CODE = 0x7f;

// Characters that have a special meaning somewhere in a minimatch pattern.
// These are escaped with a backslash, which minimatch handles everywhere for them
const GLOB_ESCAPED_CHARS: ReadonlySet<string> = new Set('*?[(!+@');
// These are escaped in a class instead: after a star, like in `*\#`, minimatch would expect the
// backslash in the name too. The backslash is still needed, since minimatch expands braces before
// it parses classes
const GLOB_CLASS_ESCAPED_CHARS: ReadonlySet<string> = new Set(String.raw`\]{})#`);
const GLOB_CLASS_SPECIAL_CHARS: ReadonlySet<string> = new Set(String.raw`\[]-^!`);

const toGlobChar = (char: string) => {
  if (GLOB_ESCAPED_CHARS.has(char)) {
    return `\\${char}`;
  }
  return GLOB_CLASS_ESCAPED_CHARS.has(char) ? `[\\${char}]` : char;
};

const toGlobClassChar = (code: number) => {
  const char = String.fromCodePoint(code);
  return GLOB_CLASS_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
};

const toGlobClass = ({negated, members}: Extract<Token, {type: 'class'}>) => {
  const parts = members
    .flatMap(([from, to]): ClassRange[] => {
      // In minimatch, a class matches a whole character, never a single byte of a non-ASCII one.
      // A slash in a class breaks the whole pattern, and it can't match anyway
      const asciiTo = Math.min(to, MAX_ASCII_CODE);
      if (from > asciiTo || (from === SLASH_CODE && asciiTo === SLASH_CODE)) {
        return [];
      }
      if (from > SLASH_CODE || asciiTo < SLASH_CODE) {
        return [[from, asciiTo]];
      }
      return [
        ...(from < SLASH_CODE ? [[from, SLASH_CODE - 1] as const] : []),
        ...(asciiTo > SLASH_CODE ? [[SLASH_CODE + 1, asciiTo] as const] : []),
      ];
    })
    .map(([from, to]) => formatRange(from, to, toGlobClassChar))
    .join('');
  if (parts.length === 0) {
    // `[!]` would not be a class at all
    return negated ? '?' : undefined;
  }
  return `[${negated ? '!' : ''}${parts}]`;
};

/** Returns `undefined` if the tokens can never match anything */
const toGlob = (tokens: readonly Token[], isAnchored: boolean) => {
  const parts = tokens.map((token, index) => {
    if (token.type === 'literal') {
      return token.value === SLASH ? SLASH : toGlobChar(token.value);
    }
    if (token.type === 'any') {
      return '?';
    }
    if (token.type === 'class') {
      return toGlobClass(token);
    }
    // A component can't have a slash in it, so there `**` is the same as `*`
    return isAnchored && isGlobstar(tokens, index) ? '**' : '*';
  });
  return parts.includes(undefined) ? undefined : parts.join('');
};

const toGlobLiteral = (value: string) => Array.from(value, toGlobChar).join('');

const splitSegments = (tokens: readonly Token[]) =>
  tokens.reduce<Token[][]>(
    (segments, token) => {
      if (isSlash(token)) {
        segments.push([]);
      } else {
        segments.at(-1)?.push(token);
      }
      return segments;
    },
    [[]],
  );

const isGlobstarSegment = ([token, ...rest]: readonly Token[]) =>
  rest.length === 0 && token?.type === 'stars' && token.count > 1;

/**
 * Finds what an anchored pattern means for paths inside the given subdirectory of its base.
 * For example, `packages/*\/dist` becomes `dist` for `packages/foo`.
 * The result can have multiple patterns, any of them matching means the original matches.
 * Matches of the subdirectory itself or its parents are left out
 */
const rebaseTokens = (
  tokens: readonly Token[],
  subdirectorySegments: readonly string[],
  isCaseInsensitive: boolean,
) => {
  const segments = splitSegments(tokens);
  const positions = subdirectorySegments.reduce(
    (currentPositions, name) => {
      const nextPositions = new Set<number>();
      const normalizedName = normalizeCase(name, isCaseInsensitive);
      const visit = (position: number) => {
        const segment = segments[position];
        if (segment) {
          if (isGlobstarSegment(segment)) {
            nextPositions.add(position);
            visit(position + 1);
          } else if (compileTokens(segment, isCaseInsensitive)(normalizedName)) {
            nextPositions.add(position + 1);
          }
        }
      };
      currentPositions.forEach(visit);
      return nextPositions;
    },
    new Set([0]),
  );
  return [...positions]
    .filter((position) => position < segments.length)
    .map((position) =>
      segments
        .slice(position)
        .flatMap((segment, index): Token[] => (index === 0 ? segment : [SLASH_TOKEN, ...segment])),
    );
};

/** Globs relative to `cwdDirectory`, `undefined` stands for one that can never match */
const getGlobs = (
  {rule, tokens}: CompiledRule,
  sourceDirectory: string,
  cwdDirectory: string,
  isCaseInsensitive: boolean,
) => {
  if (!tokens) {
    return [];
  }
  if (isInsideDirectory(sourceDirectory, cwdDirectory)) {
    const prefix =
      sourceDirectory === cwdDirectory
        ? ''
        : `${toGlobLiteral(getPathInDirectory(sourceDirectory, cwdDirectory))}/`;
    const glob = toGlob(tokens, rule.anchored);
    return [glob == null ? glob : `${prefix}${rule.anchored ? '' : '**/'}${glob}`];
  }
  if (!isInsideDirectory(cwdDirectory, sourceDirectory)) {
    return [];
  }
  if (rule.anchored) {
    const subdirectorySegments = getPathInDirectory(cwdDirectory, sourceDirectory).split('/');
    return rebaseTokens(tokens, subdirectorySegments, isCaseInsensitive).map((rebased) =>
      toGlob(rebased, true),
    );
  }
  const glob = toGlob(tokens, false);
  return [glob == null ? glob : `**/${glob}`];
};

const ruleToEslintIgnores = (
  compiled: CompiledRule,
  sourceDirectory: string,
  cwdDirectory: string,
  isCaseInsensitive: boolean,
) =>
  getGlobs(compiled, sourceDirectory, cwdDirectory, isCaseInsensitive).flatMap((glob) => {
    if (glob == null) {
      return [];
    }
    // Unlike git, minimatch matches the directory itself with `dir/**`
    const fixedGlob = glob !== '**' && glob.endsWith('/**') ? `${glob}/*` : glob;
    const {negated, directoryOnly} = compiled.rule;
    return fromByteString(`${negated ? '!' : ''}${fixedGlob}${directoryOnly ? '/' : ''}`);
  });

/** Keeps the last occurrence of each glob: the earlier ones can't change the outcome */
const removeDuplicates = (globs: readonly string[]) => {
  const lastIndexes = new Map(globs.map((glob, index) => [glob, index]));
  return globs.filter((glob, index) => lastIndexes.get(glob) === index);
};

/**
 * Converts the rules of the sources (in the order of increasing precedence) into patterns relative
 * to `cwdDirectory`, a byte string relative to the base directory
 */
export const toEslintIgnores = (
  sources: readonly EslintIgnoresSource[],
  cwdDirectory: string,
  isCaseInsensitive: boolean,
) =>
  removeDuplicates(
    sources.flatMap(({directory, rules}) =>
      rules.flatMap((rule) =>
        ruleToEslintIgnores(rule, directory, cwdDirectory, isCaseInsensitive),
      ),
    ),
  );
