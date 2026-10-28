import path from 'node:path';
import type {QuansyncGenerator} from 'quansync';
import {getEntryTypes, readFiles, readFilesAndGetRealPaths} from './fs.ts';
import {DOT_GIT, getAncestors} from './path.ts';

export interface GitRepository {
  /** The top-level directory of the working tree */
  workTree: string;

  /**
   * The git directory (git's `$GIT_DIR`): `<workTree>/.git`, or the directory a `.git` file points
   * to, as in linked worktrees and submodules.
   * Absent if the `.git` file is invalid
   */
  gitDirectory?: string;

  /**
   * The directory with the files shared by all worktrees, such as `info/exclude` and `config`.
   * Only differs from `gitDirectory` in linked worktrees
   */
  commonDirectory?: string;
}

const GIT_DIRECTORY_PREFIX = 'gitdir: ';

const trimTrailingLineBreaks = (value: string) => {
  let end = value.length;
  while (end > 0 && '\n\r'.includes(value.charAt(end - 1))) {
    end--;
  }
  return value.slice(0, end);
};

/** Returns the directory the `.git` file points to, `undefined` if the file is invalid */
function* readGitFile(filePath: string): QuansyncGenerator<string | undefined> {
  const [content] = yield* readFiles([{path: filePath}]);
  const target = content?.startsWith(GIT_DIRECTORY_PREFIX)
    ? trimTrailingLineBreaks(content.slice(GIT_DIRECTORY_PREFIX.length))
    : undefined;
  return target ? path.resolve(path.dirname(filePath), target) : undefined;
}

/**
 * Finds the git repository the directory belongs to, the way git does: by looking for a `.git`
 * directory or file in it and its parents.
 * `GIT_DIR` and other environment variables are not taken into account.
 * The directory doesn't have to exist, but the result tells if it does.
 * Also returns the content of `HEAD` and the real path of the git directory
 */
export function* discoverRepository(directory: string): QuansyncGenerator<{
  isDirectory: boolean;
  repository?: GitRepository;
  head?: string;
  realGitDirectory?: string;
}> {
  const ancestors = getAncestors(directory);
  // The directory itself is checked together with the `.git` entries
  const [directoryType, ...types] = yield* getEntryTypes([
    directory,
    ...ancestors.map((ancestor) => path.join(ancestor, DOT_GIT)),
  ]);
  const isDirectory = directoryType === 'directory';
  const index = types.findIndex((type) => type === 'directory' || type === 'file');
  const workTree = ancestors[index];
  if (workTree == null) {
    return {isDirectory};
  }
  const dotGitPath = path.join(workTree, DOT_GIT);
  const gitDirectory = types[index] === 'file' ? yield* readGitFile(dotGitPath) : dotGitPath;
  if (gitDirectory == null) {
    return {isDirectory, repository: {workTree}};
  }
  const [[commonDirectoryTarget, head], [realGitDirectory]] = yield* readFilesAndGetRealPaths(
    [{path: path.join(gitDirectory, 'commondir')}, {path: path.join(gitDirectory, 'HEAD')}],
    [gitDirectory],
  );
  const commonDirectory =
    commonDirectoryTarget == null ? undefined : trimTrailingLineBreaks(commonDirectoryTarget);
  return {
    isDirectory,
    repository: {
      workTree,
      gitDirectory,
      commonDirectory: commonDirectory ? path.resolve(gitDirectory, commonDirectory) : gitDirectory,
    },
    ...(head != null && {head}),
    ...(realGitDirectory != null && {realGitDirectory}),
  };
}
