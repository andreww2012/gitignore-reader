import {getEnvironmentConfig, isTruthyGitValue, parseGitConfig} from '../src/git-config.ts';

const TAB = '\t';

const parseValues = (lines: readonly string[]) =>
  parseGitConfig(['[s]', ...lines].join('\n')).map((entry) => entry.value);

describe('parseGitConfig', () => {
  it('parses sections, subsections, keys and values', () => {
    expect(
      parseGitConfig(
        [
          '# comment',
          '[Core] ; comment',
          `\tExcludesFile = ~/a b${' '.repeat(2)}# comment`,
          `${' '.repeat(2)}bare`,
          '[includeIf "gitdir:~/Work/"]',
          String.raw`path = "with \"quotes\" and ; # " kept`,
          '[old.Style] key = value',
          String.raw`multi = one \ `.trimEnd(),
          `${' '.repeat(2)}two`,
          String.raw`escapes = "\t\n\\"`,
          'empty =',
        ].join('\n'),
      ),
    ).toStrictEqual([
      {section: 'core', key: 'excludesfile', value: '~/a b', line: 3},
      {section: 'core', key: 'bare', line: 4},
      {
        section: 'includeif',
        subsection: 'gitdir:~/Work/',
        key: 'path',
        value: `with "quotes" and ; #${' '.repeat(2)}kept`,
        line: 6,
      },
      {section: 'old', subsection: 'style', key: 'key', value: 'value', line: 7},
      {section: 'old', subsection: 'style', key: 'multi', value: `one${' '.repeat(3)}two`, line: 8},
      {section: 'old', subsection: 'style', key: 'escapes', value: '\t\n\\', line: 10},
      {section: 'old', subsection: 'style', key: 'empty', value: '', line: 11},
    ]);
  });

  // Checked against `git config --get`
  it('keeps the spaces inside a value as they are, but not around it', () => {
    expect(
      parseValues([
        'a = x\ty',
        `b =${' '.repeat(3)}x${' '.repeat(2)}y ${TAB}`,
        `c = x ${TAB} ;comment`,
        'd = x " " y ',
        `e = "x" ${TAB}`,
        String.raw`f = x\t  `,
        'g = " " ',
        // A raw string can't end with a backslash
        'h = x \\',
        '',
        'i = x\ry',
        `j =${TAB} `,
      ]),
    ).toStrictEqual([
      'x\ty',
      `x${' '.repeat(2)}y`,
      'x',
      `x${' '.repeat(3)}y`,
      'x',
      'x\t',
      ' ',
      'x ',
      'x\ry',
      '',
    ]);
  });

  it('handles CRLF and the end of the content like `\\n`', () => {
    expect(parseGitConfig('[s]\r\na = x\r\nb\r\n[t "u"]\r\nc = "y"')).toStrictEqual([
      {section: 's', key: 'a', value: 'x', line: 2},
      {section: 's', key: 'b', line: 3},
      {section: 't', subsection: 'u', key: 'c', value: 'y', line: 5},
    ]);
  });

  it('only treats tabs, line breaks and spaces as spaces, like git', () => {
    expect(parseValues(['a = \vx\f'])).toStrictEqual(['\vx\f']);
    expect(parseGitConfig('[s]\n\va = x')).toStrictEqual([]);
  });

  it('splits the name like git', () => {
    expect(parseGitConfig('[a.B "C.d"]\nk = v\n[e.F]\nk = v')).toStrictEqual([
      {section: 'a', subsection: 'b.C.d', key: 'k', value: 'v', line: 2},
      {section: 'e', subsection: 'f', key: 'k', value: 'v', line: 4},
    ]);
  });

  it('stops at a syntax error, like git does', () => {
    expect(parseGitConfig('[core]\na = 1\n1bad\nb = 2')).toStrictEqual([
      {section: 'core', key: 'a', value: '1', line: 2},
    ]);
    expect(parseGitConfig('[core]\na = "unterminated\nb = 2')).toStrictEqual([]);
    expect(
      parseGitConfig(String.raw`[core]
a = \x`),
    ).toStrictEqual([]);
    expect(parseGitConfig('[core]\na ; comment\nb = 2')).toStrictEqual([]);
    expect(parseGitConfig('[]\na = 1')).toStrictEqual([]);
    expect(parseGitConfig('[core "x" ]\na = 1')).toStrictEqual([]);
  });

  it('ignores keys without a section', () => {
    expect(parseGitConfig('a = 1\n[s]\nb = 2')).toStrictEqual([
      {section: 's', key: 'b', value: '2', line: 3},
    ]);
  });
});

describe('getEnvironmentConfig', () => {
  it('reads the config from environment variables', () => {
    expect(
      getEnvironmentConfig({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: '/x',
        GIT_CONFIG_KEY_1: 'includeIf.gitdir:/a/.path',
        GIT_CONFIG_VALUE_1: '/y',
      }),
    ).toStrictEqual([
      {section: 'core', key: 'excludesfile', value: '/x', line: 0},
      {section: 'includeif', subsection: 'gitdir:/a/', key: 'path', value: '/y', line: 0},
    ]);
  });
});

describe('isTruthyGitValue', () => {
  it.each([
    ['true', true],
    ['YES', true],
    ['on', true],
    ['1', true],
    ['-1', true],
    ['0x10', true],
    ['010', true],
    ['1k', true],
    [' 1', true],
    ['false', false],
    ['', false],
    ['0', false],
    ['0x0', false],
    ['00', false],
    ['0k', false],
    ['1 ', false],
    ['08', false],
    ['maybe', false],
  ] as const)('%j: %s', (value, expected) => {
    expect(isTruthyGitValue(value)).toBe(expected);
  });
});
