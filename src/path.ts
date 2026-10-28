// Native paths are absolute. Relative paths are relative to the base directory (the working tree
// or the filesystem root), POSIX-style, and an empty one stands for the base directory itself
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toForwardSlashes} from 'utilery/path';
import {isPathInside} from 'utilery/server';
import {substringBeforeLast} from 'utilery/string';

export const DOT_GIT = '.git';

export const toPath = (value: string | URL) =>
  typeof value === 'string' ? value : fileURLToPath(value);

export const toPosixPath = (value: string) => (path.sep === '\\' ? toForwardSlashes(value) : value);

/** For native paths */
export const isPathInsideOrSame = (child: string, parent: string) =>
  path.relative(parent, child).length === 0 || isPathInside(child, parent);

/** The directory and its parents, starting from the directory */
export const getAncestors = (directory: string) => {
  const ancestors = [directory];
  for (
    let parent = path.dirname(directory);
    parent !== ancestors.at(-1);
    parent = path.dirname(parent)
  ) {
    ancestors.push(parent);
  }
  return ancestors;
};

/** For relative paths, also returns `true` for the same path */
export const isInsideDirectory = (relativePath: string, directory: string) =>
  directory.length === 0 || relativePath === directory || relativePath.startsWith(`${directory}/`);

/** For relative paths, expects the path to be inside the directory */
export const getPathInDirectory = (relativePath: string, directory: string) =>
  directory.length === 0 ? relativePath : relativePath.slice(directory.length + 1);

export const joinRelativePath = (directory: string, name: string) =>
  directory.length === 0 ? name : `${directory}/${name}`;

/** For relative paths, returns an empty string for a top-level one */
export const getParentDirectory = (relativePath: string) =>
  substringBeforeLast(relativePath, '/', '');
