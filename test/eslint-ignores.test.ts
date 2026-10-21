import {toEslintIgnores} from '../src/eslint-ignores.ts';
import {compileGitignore, toByteString} from '../src/pattern.ts';

/** Converts the rules of a gitignore file in the base directory, relative to `cwd` */
const convert = (content: string, cwd = '') =>
  toEslintIgnores(
    [{directory: '', rules: compileGitignore(content, false)}],
    toByteString(cwd),
    false,
  );

describe('toEslintIgnores', () => {
  it('escapes what is special in minimatch only', () => {
    expect(convert('/{a,b}(c)+@!#d')).toStrictEqual([String.raw`[\{]a,b[\}]\(c[\)]\+\@\![\#]d`]);
    // minimatch would compare the end of `*\#` with `\#`, backslash included
    expect(convert('*.lyx#')).toStrictEqual([String.raw`**/*.lyx[\#]`]);
    expect(convert(String.raw`/\]\\`)).toStrictEqual([String.raw`[\]][\\]`]);
    expect(convert(String.raw`/a\*b\?`)).toStrictEqual([String.raw`a\*b\?`]);
  });

  it('converts classes', () => {
    expect(convert('/[!a-c]')).toStrictEqual(['[!a-c]']);
    expect(convert('/[]^!-]')).toStrictEqual([String.raw`[\]\^\!\-]`]);
    // `!` would negate the class if not escaped
    expect(convert('/[[:punct:]]')).toStrictEqual([`${String.raw`[\!-.:-@\[-`}\`{-~]`]);
    expect(convert('/[!/]')).toStrictEqual(['?']);
    expect(convert('/[/]')).toStrictEqual([]);
  });

  it('converts stars', () => {
    expect(convert('/***/a/**b/**')).toStrictEqual(['**/a/*b/**/*']);
    expect(convert('***')).toStrictEqual(['**/*']);
    expect(convert(String.raw`a/**\/b`)).toStrictEqual(['a/*/**/b']);
  });

  it('leaves out the rules with empty segments, which never match', () => {
    // minimatch would ignore the extra slashes
    expect(convert(['/', '!/', '//', 'a//b', 'a//', String.raw`\/a`].join('\n'))).toStrictEqual([]);
  });

  it('keeps non-ASCII characters', () => {
    expect(convert('é?\n/日本/[éa]')).toStrictEqual(['**/é?', '日本/[a]']);
    expect(convert('/x\n/日本/*/y', '日本/z')).toStrictEqual(['y']);
    // A class can't match a single byte of a character in ESLint
    expect(convert('[é]')).toStrictEqual([]);
    expect(convert('[!é]')).toStrictEqual(['**/?']);
  });
});
