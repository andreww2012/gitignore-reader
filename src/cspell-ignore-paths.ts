// Patterns for cspell's `ignorePaths`, which it matches with picomatch. cspell skips negated
// patterns there, so instead of converting the rules, the paths they ignore are listed
import path from 'node:path';
import {sortBy} from 'utilery/array';
import {readDirectories} from './fs.ts';
import {DOT_GIT, joinRelativePath} from './path.ts';

// Characters that are special in picomatch, and whitespace, which cspell trims at the end (and `#`
// after it starts a comment). They are escaped in a class rather than with a backslash, which
// cspell may turn into a slash on Windows. A class still needs one for `\` and `^`, but on Windows,
// file names can't have `\`, and `[/^]` would still match `^` (and `/`)
const SPECIAL_CHARS_REGEX = /[\s!"#$()*?[\\\]^{|}]/g;

// Directories get no trailing slash: with one, cspell would still read them, though not their
// subdirectories
const toPattern = (pathInCwd: string) =>
  `/${pathInCwd.replaceAll(SPECIAL_CHARS_REGEX, (char) =>
    char === '\\' || char === '^' ? `[\\${char}]` : `[${char}]`,
  )}`;

/**
 * Lists the ignored files and directories in `cwd`, but not the contents of the ignored ones.
 * `.git` is listed too: git never looks into it, but cspell would.
 * `isIgnored` gets a path relative to `cwd`, whose parents below `cwd` are not ignored
 */
export const toCspellIgnorePaths = (
  cwd: string,
  isIgnored: (pathInCwd: string, isDirectory: boolean) => boolean,
) => {
  const findIgnoredPaths = (directoryPath: string, pathInCwd: string): string[] =>
    // The order of entries depends on the file system, but the order of the patterns must not
    sortBy(readDirectories.sync([directoryPath])[0] || [], [(entry) => entry.name]).flatMap(
      ({name, type}) => {
        const entryPath = joinRelativePath(pathInCwd, name);
        const isDirectory = type === 'directory';
        if (name === DOT_GIT || isIgnored(entryPath, isDirectory)) {
          return entryPath;
        }
        return isDirectory ? findIgnoredPaths(path.join(directoryPath, name), entryPath) : [];
      },
    );
  return findIgnoredPaths(cwd, '').map(toPattern);
};
