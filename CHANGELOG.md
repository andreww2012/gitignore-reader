# gitignore-reader-x

## 0.1.0

### Minor Changes

- [`e07656b`](https://github.com/andreww2012/gitignore-reader/commit/e07656bf8622e00867d1d57b88c1194b478dc386) - **Breaking:** `sources.excludesFile` is renamed to `sources.globalIgnoreFile`, and the `excludes-file` source type to `global-ignore-file`

- [`406b85e`](https://github.com/andreww2012/gitignore-reader/commit/406b85e020d2b0428a25848f43a826269fd6e7ba) - Added a new `toCspellIgnorePaths` method: it lists the files and directories that git ignores as patterns for cspell's `ignorePaths`

- [`98ee79d`](https://github.com/andreww2012/gitignore-reader/commit/98ee79dde83986e3c7165721426406f712d7069c) - **Breaking:** The global ignore file (`core.excludesFile`) is now only read with `sources.globalIgnoreFile`, since its rules are not specific to the project

- [`b240011`](https://github.com/andreww2012/gitignore-reader/commit/b240011082c76aa251aa389c8f3ca42899e86e50) - A missing `cwd`, or one that isn't a directory, now throws an error, unless the new `allowMissingCwd` option is set

### Patch Changes

- [`84d791f`](https://github.com/andreww2012/gitignore-reader/commit/84d791f6cc4fbc7da100deb688b94c1bcba057e6) - Node.js 22+ is now supported, instead of only 22.23.1+, 24.18.0+ and 26.4.0+

- [`2b66422`](https://github.com/andreww2012/gitignore-reader/commit/2b66422333a15e28ef13108a4c5e37428a185dc1) - `isIgnored` and `check` now treat a `file:` URL ending with `/` as a directory, like a path ending with a separator

## 0.0.1

### Patch Changes

- [`f4fa48b`](https://github.com/andreww2012/gitignore-reader/commit/f4fa48be26263eef774609636c4abfa7a4af4040) - Initial release
