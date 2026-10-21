import path from 'node:path';
import type {QuansyncGenerator} from 'quansync';
import {getEntryTypes, readFiles, readFilesAndGetRealPaths} from './fs.ts';
import {getAncestors} from './path.ts';

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

// Finds the git repository the directory belongs to, the way git does: by looking for a `.git`
// directory or file in it and its parents.
// `GIT_DIR` and other environment variables are not taken into account.
// Also returns the content of `HEAD` and the real path of the git directory
export function* discoverRepository(directory: string): QuansyncGenerator<{
  repository?: GitRepository;
  head?: string;
  realGitDirectory?: string;
}> {
  const ancestors = getAncestors(directory);
  const types = yield* getEntryTypes(ancestors.map((ancestor) => path.join(ancestor, '.git')));
  const index = types.findIndex((type) => type === 'directory' || type === 'file');
  const workTree = ancestors[index];
  if (workTree == null) {
    return {};
  }
  let gitDirectory: string | undefined = path.join(workTree, '.git');
  if (types[index] === 'file') {
    const [content] = yield* readFiles([{path: gitDirectory}]);
    const target = content?.startsWith(GIT_DIRECTORY_PREFIX)
      ? trimTrailingLineBreaks(content.slice(GIT_DIRECTORY_PREFIX.length))
      : undefined;
    gitDirectory = target ? path.resolve(workTree, target) : undefined;
  }
  if (gitDirectory == null) {
    return {repository: {workTree}};
  }
  const [[commonDirectoryTarget, head], [realGitDirectory]] = yield* readFilesAndGetRealPaths(
    [{path: path.join(gitDirectory, 'commondir')}, {path: path.join(gitDirectory, 'HEAD')}],
    [gitDirectory],
  );
  const commonDirectory =
    commonDirectoryTarget == null ? undefined : trimTrailingLineBreaks(commonDirectoryTarget);
  return {
    repository: {
      workTree,
      gitDirectory,
      commonDirectory: commonDirectory ? path.resolve(gitDirectory, commonDirectory) : gitDirectory,
    },
    ...(head != null && {head}),
    ...(realGitDirectory != null && {realGitDirectory}),
  };
}
