// Batched fs operations: sequential in sync mode, concurrent in async mode.
// Errors are swallowed, since a missing or unreadable file just means there are no rules in it
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {type QuansyncGenerator, quansync} from 'quansync';

interface FileToRead {
  path: string;

  /**
   * Git doesn't follow symlinks when it reads ignore files from the working tree
   * @default true
   */
  followSymlinks?: boolean;
}

// Windows has no flag to refuse opening a symlink, so there git checks for one first, and so does
// this code
const HAS_NO_FOLLOW_FLAG = 'O_NOFOLLOW' in fs.constants;
const READ_NO_FOLLOW_FLAG = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

const readFileSync = ({path, followSymlinks = true}: FileToRead) => {
  if (followSymlinks) {
    return fs.readFileSync(path, 'utf8');
  }
  if (!HAS_NO_FOLLOW_FLAG) {
    return fs.lstatSync(path, {throwIfNoEntry: false})?.isSymbolicLink()
      ? undefined
      : fs.readFileSync(path, 'utf8');
  }
  const fileDescriptor = fs.openSync(path, READ_NO_FOLLOW_FLAG);
  try {
    return fs.readFileSync(fileDescriptor, 'utf8');
  } finally {
    fs.closeSync(fileDescriptor);
  }
};

const readFileAsync = async ({path, followSymlinks = true}: FileToRead) => {
  if (!followSymlinks && !HAS_NO_FOLLOW_FLAG && (await fsPromises.lstat(path)).isSymbolicLink()) {
    return undefined;
  }
  return await fsPromises.readFile(path, {
    encoding: 'utf8',
    flag: followSymlinks ? 'r' : READ_NO_FOLLOW_FLAG,
  });
};

const getEntryType = (entry: fs.Dirent | fs.Stats) => {
  if (entry.isDirectory()) {
    return 'directory';
  }
  // Symlinks are `other` too, since git doesn't follow them in the working tree
  return entry.isFile() ? 'file' : 'other';
};

const toDirectoryEntries = (entries: fs.Dirent[]) =>
  entries.map((entry) => ({name: entry.name, type: getEntryType(entry)}));

const swallowErrors = <T>(fn: () => T) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

const ignoreError = () => undefined;

/** Reads the files as UTF-8, `undefined` stands for a file that can't be read for any reason */
export const readFiles = quansync({
  sync: (files: readonly FileToRead[]) =>
    files.map((file) => swallowErrors(() => readFileSync(file))),
  async: (files: readonly FileToRead[]) =>
    Promise.all(files.map((file) => readFileAsync(file).catch(ignoreError))),
});

/** `undefined` stands for a directory that can't be read for any reason */
export const readDirectories = quansync({
  sync: (directoryPaths: readonly string[]) =>
    directoryPaths.map((directoryPath) =>
      swallowErrors(() => toDirectoryEntries(fs.readdirSync(directoryPath, {withFileTypes: true}))),
    ),
  async: (directoryPaths: readonly string[]) =>
    Promise.all(
      directoryPaths.map((directoryPath) =>
        fsPromises
          .readdir(directoryPath, {withFileTypes: true})
          .then(toDirectoryEntries)
          .catch(ignoreError),
      ),
    ),
});

/** Follows symlinks, `undefined` stands for a missing entry */
export const getEntryTypes = quansync({
  sync: (entryPaths: readonly string[]) =>
    entryPaths.map((entryPath) =>
      swallowErrors(() => {
        const stats = fs.statSync(entryPath, {throwIfNoEntry: false});
        return stats && getEntryType(stats);
      }),
    ),
  async: (entryPaths: readonly string[]) =>
    Promise.all(
      entryPaths.map((entryPath) =>
        fsPromises.stat(entryPath).then(getEntryType).catch(ignoreError),
      ),
    ),
});

/** Resolves symlinks, `undefined` stands for a path that can't be resolved */
export const getRealPaths = quansync({
  sync: (entryPaths: readonly string[]) =>
    entryPaths.map((entryPath) => swallowErrors(() => fs.realpathSync.native(entryPath))),
  async: (entryPaths: readonly string[]) =>
    Promise.all(entryPaths.map((entryPath) => fsPromises.realpath(entryPath).catch(ignoreError))),
});

/** `readFiles` and `getRealPaths` at once */
export const readFilesAndGetRealPaths = quansync({
  sync: (
    files: readonly FileToRead[],
    entryPaths: readonly string[],
  ): [(string | undefined)[], (string | undefined)[]] => [
    readFiles.sync(files),
    getRealPaths.sync(entryPaths),
  ],
  async: (files: readonly FileToRead[], entryPaths: readonly string[]) =>
    Promise.all([readFiles.async(files), getRealPaths.async(entryPaths)]),
});

/** Reads all the files at once and returns their contents grouped the same way */
export function* readFileGroups(
  groups: readonly (readonly FileToRead[])[],
): QuansyncGenerator<(string | undefined)[][]> {
  const contents = yield* readFiles(groups.flat());
  return groups.reduce<{offset: number; result: (string | undefined)[][]}>(
    (accumulator, group) => {
      accumulator.result.push(
        contents.slice(accumulator.offset, accumulator.offset + group.length),
      );
      accumulator.offset += group.length;
      return accumulator;
    },
    {offset: 0, result: []},
  ).result;
}
