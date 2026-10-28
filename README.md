# gitignore-reader-x [![npm](https://img.shields.io/npm/v/gitignore-reader-x)](https://npmx.dev/gitignore-reader-x)

Tells which files git ignores, without running git.
It reads the rules from every source git does, matches them exactly like git, and can convert them into ESLint's `ignores`.

- 📚 **Every source**: nested and parent `.gitignore` files, `.git/info/exclude`, the global ignore file, submodules.
- 🎯 **Same results as git**: tested against `git check-ignore` on thousands of random & popular repositories.
- 🧩 **Works with any tool**: check paths with `isIgnored`, or get patterns for ESLint.
- ⚡ **Fast**: never looks into ignored directories and reads files concurrently.
- 🔁 **Sync and async** APIs are provided.

## Use cases

- **ESLint configs**: ignore exactly what git ignores, including nested `.gitignore` files and the root one when ESLint runs in a monorepo package.
- **Linters, formatters, spell checkers and other tools** that should skip ignored files: call `isIgnored` for each file.
- **File walkers and watchers**: skip ignored directories without reading them.
- **Debugging**: find out which rule in which file ignores a path, like `git check-ignore --verbose` does.

## Comparison with other packages

|                                          | gitignore-reader-x | [eslint-config-flat-gitignore] | [cspell-gitignore] | [ignore]    |
| ---------------------------------------- | ------------------ | ------------------------------ | ------------------ | ----------- |
| Nested `.gitignore` files                | Yes                | Opt-in                         | Yes                | No          |
| Parent `.gitignore` files                | Yes                | The closest one only           | Yes                | No          |
| `.git/info/exclude`                      | Yes                | Partly [^1]                    | No                 | No          |
| Global ignore file (`core.excludesFile`) | Yes                | No                             | No                 | No          |
| Submodules and nested repositories       | Yes                | Partly [^1]                    | No                 | No          |
| Checks if a path is ignored              | Yes                | No                             | Yes                | Yes [^2]    |
| Patterns for ESLint                      | Yes                | Yes                            | No                 | No          |
| Same results as git                      | Yes [^3]           | Not always [^1]                | Not always [^4]    | Almost [^5] |

It's fast too: ignored directories are never searched, files are read concurrently, and most rules are looked up instead of being tested one by one.
For example, in a repository with 2,000 files `readGitignore` takes about 6 ms on one machine, three times less than eslint-config-flat-gitignore with `recursive: true`.

## Usage

```sh
pnpm i gitignore-reader-x
```

Replace `pnpm i` with the installation command of your package manager.

Node.js 22+ is required.

### ESLint

Use the directory of your ESLint config as `cwd`, since ESLint resolves `ignores` relative to it:

```ts
// eslint.config.ts
import {defineConfig, globalIgnores} from 'eslint/config';
import {readGitignore} from 'gitignore-reader-x';

const gitignore = await readGitignore({cwd: import.meta.dirname});

export default defineConfig([
  globalIgnores(gitignore.toEslintIgnores(), 'gitignore'),
  // Your configs
]);
```

The patterns are made for ESLint: other tools apply ignore patterns differently, so use `isIgnored` with them.

The patterns are always case-sensitive, since ESLint matches paths case-sensitively.
Git doesn't on macOS and Windows (it sets `core.ignoreCase` there), so a file named `Dist` is ignored by the rule `dist` in git and by `isIgnored`, but not in ESLint.

Git matches bytes, so in names with non-ASCII characters `?` and `[...]` match a single byte of a character in git, but a whole character in ESLint.
For example, `?.txt` doesn't match `é.txt` in git, since `é` takes two bytes.

If you cache your config, hash the patterns to get a part of the cache key.
They only change when a rule that matters for `cwd` changes, and their order doesn't depend on the file system.

### Checking paths

```ts
import {readGitignoreSync} from 'gitignore-reader-x';

const gitignore = readGitignoreSync();

gitignore.isIgnored('dist/index.js'); // true
gitignore.isIgnored('build/'); // Directory-only rules like `build/` need a trailing slash or `isIgnored('build', true)`

gitignore.check('src/generated/types.ts');
// {
//   ignored: true,
//   rule: {pattern: 'generated/', line: 3, negated: false, directoryOnly: true, anchored: false},
//   source: {type: 'ignore-file', path: '/repo/src/.gitignore', ...},
//   matchedPath: '/repo/src/generated',
// }
```

Paths can be absolute or relative to `cwd`.

`readGitignore` reads the files concurrently, `readGitignoreSync` (or `readGitignore.sync`) one by one.
`readGitignore` is a [quansync](https://npmx.dev/quansync) function, so you can also use it in your own ones with `yield*`.

## What it reads

From the lowest precedence to the highest:

1. The global ignore file: `core.excludesFile` from git config files (with their includes), or `~/.config/git/ignore` if it's not set.
2. `$GIT_DIR/info/exclude`.
3. `.gitignore` files from the root of the repository down to `cwd`, and in every subdirectory of `cwd` that is not ignored.
4. Submodules and nested repositories: git doesn't ignore them, but their files belong to other repositories.

Outside of a git repository, only `.gitignore` files are read: from `root` (the filesystem root by default) down to `cwd`, and in the subdirectories.

## Options

Relative paths in the options are resolved against `cwd`, and `cwd` itself against the current working directory.

| Option                       | Default           | Description                                                                                           |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `cwd`                        | `process.cwd()`   | The directory to read the rules for. Paths and ESLint patterns are relative to it.                    |
| `allowMissingCwd`            | `false`           | Whether `cwd` may be missing. Otherwise, a missing `cwd` throws, so that a typo doesn't go unnoticed. |
| `root`                       | The repository    | The topmost directory to read ignore files in. Can't be above the root of the repository.             |
| `sources.globalIgnoreFile`   | `true`            | The global ignore file: `true` finds it like git does, a path sets it, `false` turns it off.          |
| `sources.infoExclude`        | `true`            | Whether to read `$GIT_DIR/info/exclude`.                                                              |
| `sources.fileNames`          | `['.gitignore']`  | Names of the ignore files, like `['.gitignore', '.prettierignore']`.                                  |
| `sources.files`              | `[]`              | Paths of more ignore files, like `['.eslintignore']`, read even in directories that aren't searched.  |
| `sources.nested`             | `true`            | Whether to read ignore files in the subdirectories of `cwd`.                                          |
| `sources.skipDirectories`    | `[]`              | Directory names not to search for ignore files in, like `['node_modules']`. Git does search them.     |
| `sources.submodules`         | `true`            | Whether to ignore submodules.                                                                         |
| `sources.nestedRepositories` | `true`            | Whether to ignore nested repositories.                                                                |
| `ignoreCase`                 | `core.ignoreCase` | Whether to match case-insensitively. Outside of a git repository, it's off by default.                |
| `env`                        | `process.env`     | Environment variables, such as `HOME` and `GIT_CONFIG_SYSTEM`.                                        |

## API

- `readGitignore(options?)` and `readGitignoreSync(options?)` return:
  - `isIgnored(path, isDirectory?)`: tells if git would ignore the path.
  - `check(path, isDirectory?)`: the same, but also tells which rule decided it.
  - `toEslintIgnores()`: the rules as patterns for ESLint's `ignores`, relative to `cwd`.
  - `sources`: the files the rules come from, with the parsed rules.
  - `repository`: the git repository, if any.
  - `ignoreCase`: whether paths are matched case-insensitively.

## Differences from git

- Git never ignores files that are already tracked, but the index isn't read here: the results are the same as from `git check-ignore --no-index`.
- The system git config is read from `/etc/gitconfig`, where Linux distributions and Apple's git keep it.
  Other builds keep it elsewhere, for example Homebrew's git in `/opt/homebrew/etc/gitconfig`: pass its path as `GIT_CONFIG_SYSTEM` in `env`.
- `includeIf "hasconfig:..."` and the `GIT_DIR` environment variable are not supported. <!-- cspell:disable-line -->
- `~user/` and `%(prefix)/` are not expanded in paths in git config files.
- Git fails on invalid git config files and values.
  Here, a file is read up to the first syntax error, and an invalid boolean value means `false`.
- Ignore files are read as UTF-8 text, so a pattern with bytes that aren't valid UTF-8 matches differently.
- Ignore files in directories that are neither parents nor subdirectories of `cwd` are not read, except the ones from `sources.files`.

## License

[MIT](./LICENSE.md)

[^1]: Reads `.git/info/exclude` and `.gitmodules` as if their paths were relative to `cwd`, not to the root of the repository.
[^2]: Only for the rules you give it: it doesn't find or read any files.
[^3]: Tested against `git check-ignore` on thousands of random repositories, on 190 popular ones (3.6 million paths) and on every template of [github/gitignore](https://github.com/github/gitignore), and the ESLint patterns by running ESLint on them.
[^4]: A `!` rule in a nested `.gitignore` can't re-include a path that a parent `.gitignore` ignores.
[^5]: Differs from git in some edge cases, like `***`.

[cspell-gitignore]: https://npmx.dev/cspell-gitignore
[eslint-config-flat-gitignore]: https://npmx.dev/eslint-config-flat-gitignore
[ignore]: https://npmx.dev/ignore
