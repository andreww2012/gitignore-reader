// Compares the results with git on the real-world templates of https://github.com/github/gitignore.
// Opt-in, since it needs a clone of that repository: run `pnpm test:templates`
import fs from 'node:fs';
import path from 'node:path';
import {arrayWithoutFalsy} from 'utilery/array';
import {mapTimes} from 'utilery/function';
import {toForwardSlashes} from 'utilery/path';
import {readGitignoreSync} from '../src/index.ts';
import {compareWithEslint, compareWithGit, createFixture} from './utils.ts';

const TEMPLATES_DIRECTORY = process.env.GITIGNORE_TEMPLATES_DIRECTORY;

const MAX_PATHS_PER_TEMPLATE = 1500;
const TEMPLATE_TIMEOUT_MS = 60_000;
const ALL_TEMPLATES_TIMEOUT_MS = 600_000;
const STAR_FILLINGS = ['', 'x', 'ab.c'] as const;
const ANY_CHARS = ['q', '.', 'Z'] as const;
const CHARS_OUTSIDE_CLASS = ['q', 'Z', '9', '_', '~'] as const;
const NESTING_PREFIXES = ['', 'n1/', 'n1/n2/'] as const;
// Not valid in file names on every platform
const INVALID_NAME_CHARS_REGEX = process.platform === 'win32' ? /["*:<>?\\|]/ : /\0/;
// `[:name:]`, an escaped character or any other one
const CLASS_MEMBER_REGEX = /\[:([a-z]+):\]|\\(.)|(.)/gsu;
// An escaped character, stars, `?`, a class (its first character can be `]`, like in git) or any
// other character
// eslint-disable-next-line sonar/super-linear-regex -- only used on short segments of patterns
const SEGMENT_PART_REGEX = /\\(.)|(\*+)|(\?)|\[(\]?[^\]]*)\]|(.)/gsu;
const GLOBSTAR_REGEX = /^\*{2,}$/;
const ASCII_LETTER_REGEX = /[a-z]/i;
const LINE_BREAK_REGEX = /\r?\n/;
const GITIGNORE_EXTENSION_REGEX = /\.gitignore$/;
const POSIX_CLASS_EXAMPLES: Readonly<Record<string, string>> = Object.freeze({
  alnum: 'a',
  alpha: 'b',
  blank: ' ',
  digit: '7',
  graph: '%',
  lower: 'c',
  print: 'd',
  punct: '!',
  space: ' ',
  upper: 'D',
  xdigit: 'f',
});

interface CandidatePath {
  segments: string[];
  isDirectory: boolean;
}

const listTemplates = (directory: string) =>
  fs
    .readdirSync(directory, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.gitignore'))
    .map((entry) =>
      toForwardSlashes(path.relative(directory, path.join(entry.parentPath, entry.name))),
    )
    .toSorted();

/** Picks a character the class matches (or doesn't match, if negated) */
const instantiateClass = (body: string, variant: number) => {
  const isNegated = body.startsWith('!') || body.startsWith('^');
  const members = [...body.slice(isNegated ? 1 : 0).matchAll(CLASS_MEMBER_REGEX)].flatMap(
    ([, posixClass, escaped, char]) => {
      if (posixClass != null) {
        return POSIX_CLASS_EXAMPLES[posixClass] || 'a';
      }
      return escaped || (char === '-' || char == null ? [] : char);
    },
  );
  return isNegated
    ? CHARS_OUTSIDE_CLASS.find((char) => !members.includes(char)) || 'q'
    : members[variant % Math.max(members.length, 1)] || 'q';
};

/** Makes a name matching the segment of a pattern, roughly: git decides what really matches */
const instantiateSegment = (segment: string, variant: number) =>
  Array.from(
    segment.matchAll(SEGMENT_PART_REGEX),
    ([, escaped, stars, question, classBody, char]) => {
      if (stars != null) {
        return STAR_FILLINGS[variant % STAR_FILLINGS.length];
      }
      if (question != null) {
        return ANY_CHARS[variant % ANY_CHARS.length];
      }
      return classBody == null ? escaped || char || '' : instantiateClass(classBody, variant);
    },
  ).join('') || 'e';

const toggleFirstLetterCase = (name: string) => {
  const index = name.search(ASCII_LETTER_REGEX);
  if (index === -1) {
    return undefined;
  }
  const letter = name.charAt(index);
  const toggled = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  return `${name.slice(0, index)}${toggled}${name.slice(index + 1)}`;
};

/** Paths that match the pattern, and some that almost do */
const createCandidatePaths = (rule: string): CandidatePath[] => {
  const trimmedRule = rule.trimEnd();
  const isDirectoryOnly = trimmedRule.endsWith('/');
  const body = trimmedRule.slice(
    trimmedRule.startsWith('!') ? 1 : 0,
    isDirectoryOnly ? -1 : undefined,
  );
  const isAnchored = body.includes('/');
  const pattern = body.startsWith('/') ? body.slice(1) : body;
  return [0, 1, 2].flatMap((variant) => {
    const segments = pattern
      .split('/')
      .flatMap((segment) =>
        GLOBSTAR_REGEX.test(segment)
          ? mapTimes(variant, (index) => `g${index}`)
          : instantiateSegment(segment, variant),
      );
    const prefix = isAnchored ? [] : arrayWithoutFalsy(NESTING_PREFIXES[variant]?.split('/') || []);
    const matching = [...prefix, ...segments];
    const lastName = matching.at(-1) || 'e';
    const caseToggled = toggleFirstLetterCase(lastName);
    const isDirectory = isDirectoryOnly || variant === 1;
    return [
      {segments: matching, isDirectory},
      {segments: [...matching.slice(0, -1), `${lastName}_x`], isDirectory: !isDirectory},
      ...(caseToggled == null
        ? []
        : [{segments: [...matching.slice(0, -1), caseToggled], isDirectory}]),
      ...(isDirectory ? [{segments: [...matching, 'child.txt'], isDirectory: false}] : []),
    ];
  });
};

const getRules = (content: string) =>
  content.split(LINE_BREAK_REGEX).filter((line) => line.trim().length > 0 && !line.startsWith('#'));

/** Creates the paths under the directory, skipping the ones that conflict with created ones */
const createPaths = (root: string, candidates: readonly CandidatePath[], limit: number) => {
  // Lowercased: the file system may be case-insensitive
  const types = new Map<string, 'directory' | 'file'>();
  let createdCount = 0;
  for (const {segments, isDirectory} of candidates) {
    if (createdCount >= limit) {
      break;
    }
    const isValid = segments.every(
      (segment) =>
        segment.length > 0 &&
        segment.length < 200 &&
        segment !== '.' &&
        segment !== '..' &&
        segment !== '.git' &&
        !INVALID_NAME_CHARS_REGEX.test(segment),
    );
    const keys = segments.map((_, index) =>
      segments
        .slice(0, index + 1)
        .join('/')
        .toLowerCase(),
    );
    const hasConflict = keys.some((key, index) => {
      const type = types.get(key);
      const expectedType = isDirectory || index < keys.length - 1 ? 'directory' : 'file';
      return type != null && type !== expectedType;
    });
    if (!isValid || hasConflict) {
      continue;
    }
    keys.forEach((key, index) => {
      types.set(key, isDirectory || index < keys.length - 1 ? 'directory' : 'file');
    });
    const fullPath = path.join(root, ...segments);
    try {
      if (isDirectory) {
        fs.mkdirSync(fullPath, {recursive: true});
      } else {
        fs.mkdirSync(path.dirname(fullPath), {recursive: true});
        fs.writeFileSync(fullPath, '');
      }
      createdCount++;
    } catch {
      // Some names may still be invalid on the current file system
    }
  }
};

describe.runIf(TEMPLATES_DIRECTORY != null)('github/gitignore templates', () => {
  const templatesDirectory = TEMPLATES_DIRECTORY || '';
  const templates = TEMPLATES_DIRECTORY == null ? [] : listTemplates(templatesDirectory);
  const readTemplate = (template: string) =>
    fs.readFileSync(path.join(templatesDirectory, template), 'utf8');

  it('has the templates', () => {
    expect(templates.length).toBeGreaterThan(100);
  });

  it.each(templates)(
    '%s',
    async (template) => {
      const content = readTemplate(template);
      const candidates = getRules(content).flatMap(createCandidatePaths);
      // The same rules at the root and deeper, so that both apply to the deeper paths
      const fixture = createFixture({
        '.gitignore': content,
        deep: {inner: {'.gitignore': content}},
      });
      createPaths(fixture.root, candidates, MAX_PATHS_PER_TEMPLATE);
      createPaths(path.join(fixture.root, 'deep', 'inner'), candidates, MAX_PATHS_PER_TEMPLATE / 3);

      const comparison = compareWithGit(
        fixture,
        readGitignoreSync({cwd: fixture.root, env: fixture.env}),
      );

      expect(comparison.mismatches).toStrictEqual([]);

      const isDeepIgnored = comparison.gitResults.some(
        (result, index) => result.ignored && comparison.entries[index]?.path === 'deep',
      );
      const eslintMismatches = await Promise.all(
        [fixture.root, ...(isDeepIgnored ? [] : [path.join(fixture.root, 'deep')])].map((cwd) =>
          compareWithEslint(fixture, cwd, comparison),
        ),
      );

      expect(eslintMismatches.flat()).toStrictEqual([]);

      fixture.git(['config', 'core.ignoreCase', 'true']);

      expect(
        compareWithGit(fixture, readGitignoreSync({cwd: fixture.root, env: fixture.env}))
          .mismatches,
      ).toStrictEqual([]);
    },
    TEMPLATE_TIMEOUT_MS,
  );

  it(
    'all of them at once, with every source',
    async () => {
      const fixture = createFixture();
      const contents = templates.map((template) => ({
        directory: path.join('t', template.replace(GITIGNORE_EXTENSION_REGEX, '')),
        content: readTemplate(template),
      }));
      contents.forEach(({directory, content}) => {
        fixture.write({[path.join(directory, '.gitignore')]: content});
        createPaths(
          path.join(fixture.root, directory),
          getRules(content).flatMap(createCandidatePaths),
          150,
        );
      });
      fixture.write({'.gitignore': readTemplate('Node.gitignore')});
      fixture.writeInfoExclude(readTemplate(path.join('Global', 'JetBrains.gitignore')));
      fixture.writeGlobalIgnore(readTemplate(path.join('Global', 'macOS.gitignore')));

      const comparison = compareWithGit(
        fixture,
        readGitignoreSync({cwd: fixture.root, env: fixture.env, sources: {globalIgnoreFile: true}}),
      );

      expect(comparison.entries.length).toBeGreaterThan(10_000);
      expect(comparison.mismatches).toStrictEqual([]);
      await expect(compareWithEslint(fixture, fixture.root, comparison)).resolves.toStrictEqual([]);
    },
    ALL_TEMPLATES_TIMEOUT_MS,
  );
});
