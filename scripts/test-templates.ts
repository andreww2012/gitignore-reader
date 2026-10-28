// Runs the template tests on https://github.com/github/gitignore, fetched at a fixed commit
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPOSITORY_URL = 'https://github.com/github/gitignore.git';
const COMMIT = '0e5d690153ca3da8a4a1aef2d053406f408f531c';
const DIRECTORY = path.resolve('node_modules/.cache/github-gitignore');

const git = (gitArguments: readonly string[]) =>
  // eslint-disable-next-line sonar/no-os-command-from-path -- the installed git is needed
  execFileSync('git', gitArguments, {cwd: DIRECTORY, encoding: 'utf8'}).trim();

const getHead = () => {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
};

fs.mkdirSync(DIRECTORY, {recursive: true});
if (!fs.existsSync(path.join(DIRECTORY, '.git'))) {
  git(['init', '--quiet']);
}
if (getHead() !== COMMIT) {
  git(['fetch', '--quiet', '--depth', '1', REPOSITORY_URL, COMMIT]);
  git(['checkout', '--quiet', '--force', 'FETCH_HEAD']);
}

// A direct dependency, so it's always there
const VITEST_PATH = path.resolve('node_modules/vitest/vitest.mjs');
execFileSync(process.execPath, [VITEST_PATH, 'run', 'test/templates.test.ts'], {
  stdio: 'inherit',
  env: {...process.env, GITIGNORE_TEMPLATES_DIRECTORY: DIRECTORY},
});
