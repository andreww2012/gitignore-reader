import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readFiles} from '../src/fs.ts';
import {symlinkOrSkip} from './utils.ts';

// Like on Windows, where opening a file can't refuse a symlink
vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  const constants = {...actual.constants};
  Reflect.deleteProperty(constants, 'O_NOFOLLOW');
  return {...actual, default: {...actual.default, constants}, constants};
});

describe('readFiles without `O_NOFOLLOW`', () => {
  it("still doesn't follow symlinks where asked to, like git", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-reader-'));
    onTestFinished(() => {
      fs.rmSync(directory, {recursive: true, force: true});
    });
    const target = path.join(directory, 'target');
    const link = path.join(directory, 'link');
    fs.writeFileSync(target, 'content');
    symlinkOrSkip(target, link, context);
    const files = [
      {path: link, followSymlinks: false},
      {path: link},
      {path: target, followSymlinks: false},
    ];

    expect(fs.constants).not.toHaveProperty('O_NOFOLLOW');
    expect(readFiles.sync(files)).toStrictEqual([undefined, 'content', 'content']);
    await expect(readFiles.async(files)).resolves.toStrictEqual([undefined, 'content', 'content']);
  });
});
