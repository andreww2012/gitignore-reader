import {compileGitignore, toByteString} from '../src/pattern.ts';

const parseGitignore = (content: string) =>
  compileGitignore(content, false).map((compiled) => compiled.rule);

const isMatching = (pattern: string, relativePath: string, isCaseInsensitive = false) => {
  const [compiled] = compileGitignore(pattern, isCaseInsensitive);
  const pathBytes = toByteString(relativePath);
  return compiled?.isMatch(pathBytes, pathBytes.slice(pathBytes.lastIndexOf('/') + 1));
};

describe('parsing', () => {
  it('skips comments and empty lines, handles BOM and CRLF', () => {
    expect(
      parseGitignore('\u{FEFF}# comment\r\n\r\nfoo\r\n \n#bar\nbaz').map((rule) => rule.pattern),
    ).toStrictEqual(['foo', 'baz']);
  });

  it('strips one `\\r` at the end of every line, even the last one', () => {
    expect(parseGitignore('a\r\r\nb\r').map((rule) => rule.pattern)).toStrictEqual(['a\r', 'b']);
  });

  it('trims unescaped trailing spaces only', () => {
    // A raw string can't end with a backslash
    const trailingBackslash = 'e\\';
    const lines = [
      `a${' '.repeat(2)}`,
      String.raw`b\ `,
      `${String.raw`c\ `} `,
      'd\t',
      trailingBackslash,
    ];

    expect(parseGitignore(lines.join('\n')).map((rule) => rule.pattern)).toStrictEqual([
      'a',
      String.raw`b\ `,
      String.raw`c\ `,
      'd\t',
      trailingBackslash,
    ]);
  });

  it('sets the flags', () => {
    expect(
      parseGitignore(String.raw`!/a/
b/c
\!d
\#e
**/f`),
    ).toStrictEqual([
      {pattern: '!/a/', line: 1, negated: true, directoryOnly: true, anchored: true},
      {pattern: 'b/c', line: 2, negated: false, directoryOnly: false, anchored: true},
      {pattern: String.raw`\!d`, line: 3, negated: false, directoryOnly: false, anchored: false},
      {pattern: String.raw`\#e`, line: 4, negated: false, directoryOnly: false, anchored: false},
      {pattern: '**/f', line: 5, negated: false, directoryOnly: false, anchored: true},
    ]);
  });
});

describe('matching a single rule', () => {
  it.each([
    ['*.js', 'a/b.js', true],
    ['*.js', 'a.jsx', false],
    ['a/*.js', 'a/b/c.js', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['**/b', 'b', true],
    ['a/**', 'a', false],
    ['a/**', 'a/x/y', true],
    ['a**b', 'a-x-b', true],
    ['a/b**c', 'a/b/x/c', false],
    ['***/z', 'x/y/z', true],
    ['?', 'a', true],
    ['a?b', 'a/b', false],
    // Git matches bytes, `é` has two of them
    ['?', 'é', false],
    ['??', 'é', true],
    ['[!a]', 'é', false],
    ['[!a][!a]', 'é', true],
    ['*[é]', 'café', true],
    ['[é]', 'é', false],
    ['é?', 'éa', true],
    ['[ab]', 'b', true],
    ['[!ab]', 'c', true],
    ['[^ab]', 'a', false],
    ['[]]', ']', true],
    ['[!]]', ']', false],
    ['[a-c]', 'b', true],
    ['[c-a]', 'c', true],
    ['[c-a]', 'b', false],
    ['[a-]', '-', true],
    ['[!-0]', '.', true],
    ['[!-0]', '-', false],
    ['x[/]y', 'x/y', false],
    ['[[:digit:]]', '5', true],
    ['[[:alpha:]]', 'é', false],
    ['[[:nope:]]', 'a', false],
    ['[[x:]', '[', true],
    ['a[', 'a[', false],
    [String.raw`\[a]`, '[a]', true],
    [String.raw`\*`, '*', true],
    [String.raw`\*`, 'a', false],
    [String.raw`a\ `, 'a ', true],

    ['a\\', 'a', false],
    [String.raw`a\/b`, 'a/b', true],
    // Unlike before a plain slash, `**` can't match zero directories before an escaped one
    [String.raw`a/**\/b`, 'a/b', false],
    [String.raw`a/**\/b`, 'a/x/b', true],
    [String.raw`a/**\/b`, 'a/x/y/b', true],
    [String.raw`**\/b`, 'b', false],
    [String.raw`**\/b`, 'x/b', true],
    [String.raw`a\/**/b`, 'a/b', true],
    // Paths never have empty segments
    ['/', 'a', false],
    ['a//b', 'a/b', false],
    ['a//', 'a', false],
    [String.raw`\/a`, 'a', false],
    ['DIST', 'dist', false],
  ] as const)('%s on %s: %s', (pattern, relativePath, expected) => {
    expect(isMatching(pattern, relativePath)).toBe(expected);
  });

  it('expects paths with the case normalized if case-insensitive', () => {
    expect(isMatching('DIST', 'dist', true)).toBe(true);
    expect(isMatching('[A-Z]*', 'x', true)).toBe(true);
  });

  // Checked against `git check-ignore` with `core.ignoreCase` set
  it.each([
    // Only ASCII letters are folded
    ['É.txt', 'é.txt', false],
    ['é.txt', 'é.txt', true],
    // A single uppercase character in a class never matches, unlike a range
    ['[A]', 'a', false],
    ['[A-A]', 'a', true],
    ['[!A]', 'a', true],
    ['[!a]', 'a', false],
    ['[[:upper:]]', 'u', true],
    // Neither does an escaped uppercase letter
    [String.raw`\Abc`, 'abc', false],
    [String.raw`\abc`, 'abc', true],
    ['Ab?', 'abz', true],
  ] as const)('%s on %s if case-insensitive: %s', (pattern, normalizedPath, expected) => {
    expect(isMatching(pattern, normalizedPath, true)).toBe(expected);
  });
});
