import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {toForwardSlashes} from 'utilery/path';
import {type ReadGitignoreOptions, readGitignore, readGitignoreSync} from '../src/index.ts';
import {type Fixture, createFixture, gitCheckIgnore, symlinkOrSkip} from './utils.ts';

describe('sources', () => {
  it('reads every source in the order of precedence', async () => {
    const fixture = createFixture({
      '.gitignore': 'root-ignored\n',
      packages: {
        '.gitignore': 'packages-ignored\n',
        a: {'.gitignore': '/a-ignored\n', src: {'.gitignore': '*.gen.ts\n'}},
      },
    });
    fixture.writeInfoExclude('info-ignored\n');
    fixture.writeGlobalIgnore('.DS_Store\n');

    const cwd = path.join(fixture.root, 'packages', 'a');
    const gitignore = await readGitignore({cwd, env: fixture.env});

    expect(gitignore.cwd).toBe(cwd);
    expect(gitignore.repository).toStrictEqual({
      workTree: fixture.root,
      gitDirectory: path.join(fixture.root, '.git'),
      commonDirectory: path.join(fixture.root, '.git'),
    });
    expect(
      gitignore.sources.map((source) => [
        source.type,
        path.relative(fixture.root, source.path || ''),
        source.rules.map((rule) => rule.pattern),
      ]),
    ).toStrictEqual([
      ['global-ignore-file', path.join('..', 'home', '.config', 'git', 'ignore'), ['.DS_Store']],
      ['info-exclude', path.join('.git', 'info', 'exclude'), ['info-ignored']],
      ['ignore-file', '.gitignore', ['root-ignored']],
      ['ignore-file', path.join('packages', '.gitignore'), ['packages-ignored']],
      ['ignore-file', path.join('packages', 'a', '.gitignore'), ['/a-ignored']],
      ['ignore-file', path.join('packages', 'a', 'src', '.gitignore'), ['*.gen.ts']],
    ]);
    expect(gitignore.toEslintIgnores()).toStrictEqual([
      '**/.DS_Store',
      '**/info-ignored',
      '**/root-ignored',
      '**/packages-ignored',
      'a-ignored',
      'src/**/*.gen.ts',
    ]);
  });

  it('sync and async results are the same', async () => {
    const fixture = createFixture({
      '.gitignore': 'dist\n!dist/keep\n',
      a: {'.gitignore': 'b/\n', b: {}, c: {'.gitignore': '*.log\n'}},
    });
    const asyncResult = await readGitignore({cwd: fixture.root, env: fixture.env});
    const syncResult = readGitignoreSync({cwd: fixture.root, env: fixture.env});

    expect(asyncResult.sources).toStrictEqual(syncResult.sources);
    expect(asyncResult.toEslintIgnores()).toStrictEqual(syncResult.toEslintIgnores());
    expect(readGitignore.sync({cwd: fixture.root, env: fixture.env}).sources).toStrictEqual(
      syncResult.sources,
    );
  });

  it('searches every directory that is not ignored by default, like git', () => {
    // Like in npm's own repository, where the dependencies are committed
    const fixture = createFixture({node_modules: {pkg: {'.gitignore': 'build/\n'}}});
    const gitignore = readGitignoreSync({cwd: fixture.root, env: fixture.env});

    expect(gitignore.toEslintIgnores()).toStrictEqual(['node_modules/pkg/**/build/']);
    expect(gitignore.isIgnored('node_modules/pkg/build/x')).toBe(true);
    expect(fixture.git(['check-ignore', '--no-index', 'node_modules/pkg/build/x'])).toBe(
      'node_modules/pkg/build/x\n',
    );
  });

  it("doesn't search ignored directories and the skipped ones", () => {
    const fixture = createFixture({
      '.gitignore': 'ignored/\n',
      ignored: {'.gitignore': 'never-read\n'},
      node_modules: {pkg: {'.gitignore': 'never-read\n'}},
      vendor: {'.gitignore': 'never-read\n'},
      src: {'.gitignore': 'read\n'},
    });
    const gitignore = readGitignoreSync({
      cwd: fixture.root,
      env: fixture.env,
      sources: {skipDirectories: ['node_modules', 'vendor']},
    });

    expect(
      gitignore.sources.map((source) => path.relative(fixture.root, source.path || '')),
    ).toStrictEqual(['.gitignore', path.join('src', '.gitignore')]);
  });

  it('`nested: false` only reads the parents and `cwd`', () => {
    const fixture = createFixture({
      '.gitignore': 'a\n',
      sub: {'.gitignore': 'b\n', deeper: {'.gitignore': 'c\n'}},
    });
    const gitignore = readGitignoreSync({
      cwd: path.join(fixture.root, 'sub'),
      env: fixture.env,
      sources: {nested: false},
    });

    expect(gitignore.toEslintIgnores()).toStrictEqual(['**/a', '**/b']);
  });

  it('`fileNames` adds other ignore files, the later ones take precedence', () => {
    const fixture = createFixture({
      '.gitignore': '*.txt\n',
      '.prettierignore': '!keep.txt\n',
      sub: {'.prettierignore': 'generated\n'},
    });
    const gitignore = readGitignoreSync({
      cwd: fixture.root,
      env: fixture.env,
      sources: {fileNames: ['.gitignore', '.prettierignore']},
    });

    expect(gitignore.toEslintIgnores()).toStrictEqual([
      '**/*.txt',
      '!**/keep.txt',
      'sub/**/generated',
    ]);
    expect(gitignore.isIgnored('a.txt')).toBe(true);
    expect(gitignore.isIgnored('keep.txt')).toBe(false);
  });

  it("doesn't follow symlinked ignore files, like git", async (context) => {
    const fixture = createFixture({'real-ignore': 'ignored\n', sub: {}});
    const target = path.join(fixture.root, 'real-ignore');
    symlinkOrSkip(target, path.join(fixture.root, '.gitignore'), context);
    symlinkOrSkip(target, path.join(fixture.root, 'sub', '.gitignore'), context);

    expect(readGitignoreSync({cwd: fixture.root, env: fixture.env}).sources).toStrictEqual([]);
    await expect(readGitignore({cwd: fixture.root, env: fixture.env})).resolves.toMatchObject({
      sources: [],
    });
    expect(gitCheckIgnore(fixture, ['ignored', 'sub/ignored'])).toStrictEqual([
      {ignored: false},
      {ignored: false},
    ]);
  });

  it('`infoExclude: false` and `globalIgnoreFile: false`', () => {
    const fixture = createFixture();
    fixture.writeInfoExclude('a\n');
    fixture.writeGlobalIgnore('b\n');

    expect(
      readGitignoreSync({
        cwd: fixture.root,
        env: fixture.env,
        sources: {infoExclude: false},
      }).toEslintIgnores(),
    ).toStrictEqual(['**/b']);
    expect(
      readGitignoreSync({
        cwd: fixture.root,
        env: fixture.env,
        sources: {globalIgnoreFile: false},
      }).toEslintIgnores(),
    ).toStrictEqual(['**/a']);
  });
});

const setUp = (gitconfig: string) => {
  const fixture = createFixture({sub: {}});
  fs.writeFileSync(fixture.env.GIT_CONFIG_GLOBAL, gitconfig);
  return fixture;
};

const getGlobalIgnoreFilePath = (
  fixture: Fixture,
  env: ReadGitignoreOptions['env'] = fixture.env,
) =>
  readGitignoreSync({cwd: fixture.root, env}).sources.find(
    (source) => source.type === 'global-ignore-file',
  )?.path;

describe('global ignore file', () => {
  it('defaults to `$XDG_CONFIG_HOME/git/ignore`', () => {
    const fixture = setUp('');
    const xdgConfigHome = path.join(fixture.home, 'xdg');
    fs.mkdirSync(path.join(xdgConfigHome, 'git'), {recursive: true});
    fs.writeFileSync(path.join(xdgConfigHome, 'git', 'ignore'), '');

    expect(getGlobalIgnoreFilePath(fixture, {...fixture.env, XDG_CONFIG_HOME: xdgConfigHome})).toBe(
      path.join(xdgConfigHome, 'git', 'ignore'),
    );
  });

  it('reads `core.excludesFile`, with `~` and quotes', () => {
    const fixture = setUp('[core]\n  excludesfile = "~/my ignore" ; comment\n');
    fs.writeFileSync(path.join(fixture.home, 'my ignore'), 'x\n');

    expect(getGlobalIgnoreFilePath(fixture)).toBe(path.join(fixture.home, 'my ignore'));
  });

  it('the last value wins, the repository config overrides the global one', () => {
    const fixture = setUp('[core]\nexcludesFile = ~/first\n[core]\nexcludesFile = ~/second\n');
    fs.writeFileSync(path.join(fixture.home, 'second'), '');
    fs.writeFileSync(path.join(fixture.home, 'local'), '');

    expect(getGlobalIgnoreFilePath(fixture)).toBe(path.join(fixture.home, 'second'));

    fixture.git(['config', 'core.excludesFile', path.join(fixture.home, 'local')]);

    expect(getGlobalIgnoreFilePath(fixture)).toBe(path.join(fixture.home, 'local'));
  });

  it('follows `include.path` and `includeIf` with `gitdir:` and `onbranch:`', () => {
    const fixture = setUp('');
    fs.writeFileSync(
      fixture.env.GIT_CONFIG_GLOBAL,
      [
        '[include]',
        '  path = included.gitconfig',
        '[includeIf "gitdir:~/elsewhere/"]',
        '  path = ~/never.gitconfig',
        // Backslashes would be dropped in a quoted subsection
        `[includeIf "gitdir/i:${toForwardSlashes(path.dirname(fixture.root)).toUpperCase()}/"]`,
        '  path = ~/conditional.gitconfig',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(fixture.home, 'included.gitconfig'), '[core]\nexcludesFile = ~/a\n');
    fs.writeFileSync(
      path.join(fixture.home, 'never.gitconfig'),
      '[core]\nexcludesFile = ~/never\n',
    );
    fs.writeFileSync(
      path.join(fixture.home, 'conditional.gitconfig'),
      '[core]\nexcludesFile = ~/b\n[includeIf "onbranch:feature/"]\npath = branch.gitconfig\n',
    );
    fs.writeFileSync(path.join(fixture.home, 'branch.gitconfig'), '[core]\nexcludesFile = ~/c\n');
    ['a', 'b', 'c'].forEach((name) => {
      fs.writeFileSync(path.join(fixture.home, name), '');
    });

    expect(getGlobalIgnoreFilePath(fixture)).toBe(path.join(fixture.home, 'b'));

    fixture.git(['checkout', '--quiet', '-b', 'feature/x']);

    expect(getGlobalIgnoreFilePath(fixture)).toBe(path.join(fixture.home, 'c'));
  });

  it('respects `GIT_CONFIG_COUNT` and `GIT_CONFIG_GLOBAL`', () => {
    const fixture = setUp('[core]\nexcludesFile = ~/global\n');
    fs.writeFileSync(path.join(fixture.home, 'global'), '');
    fs.writeFileSync(path.join(fixture.home, 'from-env'), '');

    expect(
      getGlobalIgnoreFilePath(fixture, {
        ...fixture.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: path.join(fixture.home, 'from-env'),
      }),
    ).toBe(path.join(fixture.home, 'from-env'));
    expect(
      getGlobalIgnoreFilePath(fixture, {...fixture.env, GIT_CONFIG_GLOBAL: ''}),
    ).toBeUndefined();
  });

  it('a string option sets the path, its patterns are relative to the working tree', () => {
    const fixture = setUp('');
    fs.writeFileSync(path.join(fixture.home, 'custom'), '/sub/x\nlog\n');
    const gitignore = readGitignoreSync({
      cwd: path.join(fixture.root, 'sub'),
      env: fixture.env,
      sources: {globalIgnoreFile: pathToFileURL(path.join(fixture.home, 'custom'))},
    });

    expect(gitignore.toEslintIgnores()).toStrictEqual(['x', '**/log']);
  });

  it('matches what git reads', () => {
    const fixture = setUp('[core]\n\texcludesFile = ~/.gitignore_global\n');
    fs.writeFileSync(path.join(fixture.home, '.gitignore_global'), '*.swp\n');
    fixture.write({'a.swp': ''});

    expect(fixture.git(['check-ignore', '-v', 'a.swp'])).toContain('.gitignore_global:1:*.swp');
    expect(readGitignoreSync({cwd: fixture.root, env: fixture.env}).isIgnored('a.swp')).toBe(true);
  });
});

describe('repositories', () => {
  it('linked worktrees read `info/exclude` from the main repository', () => {
    const fixture = createFixture({'.gitignore': 'ignored\n'});
    fixture.writeInfoExclude('from-info\n');
    fixture.git(['add', '.']);
    fixture.git(['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'init']);
    const worktree = path.join(path.dirname(fixture.root), 'worktree');
    fixture.git(['worktree', 'add', '--quiet', worktree]);

    const gitignore = readGitignoreSync({cwd: worktree, env: fixture.env});

    expect(gitignore.repository).toStrictEqual({
      workTree: worktree,
      gitDirectory: path.join(fixture.root, '.git', 'worktrees', 'worktree'),
      commonDirectory: path.join(fixture.root, '.git'),
    });
    expect(gitignore.toEslintIgnores()).toStrictEqual(['**/from-info', '**/ignored']);
  });

  it('submodules and nested repositories are ignored', async () => {
    const fixture = createFixture({
      '.gitmodules': '[submodule "lib"]\n\tpath = libs/lib\n\turl = ../lib.git\n',
      libs: {lib: {}},
      cloned: {'.git': 'gitdir: ../elsewhere\n', '.gitignore': 'never-read\n'},
      src: {},
    });
    const gitignore = await readGitignore({cwd: fixture.root, env: fixture.env});

    expect(gitignore.sources.map((source) => [source.type, source.rules])).toStrictEqual([
      [
        'gitmodules',
        [{pattern: '/libs/lib/', line: 2, negated: false, directoryOnly: true, anchored: true}],
      ],
      [
        'nested-repositories',
        [{pattern: '/cloned/', line: 0, negated: false, directoryOnly: true, anchored: true}],
      ],
    ]);
    expect(gitignore.toEslintIgnores()).toStrictEqual(['libs/lib/', 'cloned/']);
    expect(gitignore.isIgnored('libs/lib/index.js')).toBe(true);
    expect(gitignore.check('cloned/a.js')).toMatchObject({
      ignored: true,
      matchedPath: path.join(fixture.root, 'cloned'),
      source: {type: 'nested-repositories'},
    });
    expect(
      readGitignoreSync({
        cwd: fixture.root,
        env: fixture.env,
        sources: {submodules: false, nestedRepositories: false},
      }).toEslintIgnores(),
    ).toStrictEqual(['cloned/**/never-read']);
  });

  it('the repository is found from a subdirectory, `.git` files are followed', () => {
    const fixture = createFixture({sub: {deeper: {}}});

    expect(
      readGitignoreSync({cwd: path.join(fixture.root, 'sub', 'deeper'), env: fixture.env})
        .repository?.workTree,
    ).toBe(fixture.root);

    const separate = path.join(path.dirname(fixture.root), 'separate');
    fs.mkdirSync(path.join(separate, 'sub'), {recursive: true});
    fs.writeFileSync(path.join(separate, '.git'), `gitdir: ${path.join(fixture.root, '.git')}\n`);

    expect(
      readGitignoreSync({cwd: path.join(separate, 'sub'), env: fixture.env}).repository,
    ).toStrictEqual({
      workTree: separate,
      gitDirectory: path.join(fixture.root, '.git'),
      commonDirectory: path.join(fixture.root, '.git'),
    });
  });
});

describe('cwd', () => {
  it('must be an existing directory', async () => {
    const fixture = createFixture({file: ''}, {gitInit: false});
    const missing = path.join(fixture.root, 'missing');

    expect(() => readGitignoreSync({cwd: missing, env: fixture.env})).toThrow(
      'must be an existing directory',
    );
    expect(() =>
      readGitignoreSync({cwd: path.join(fixture.root, 'file'), env: fixture.env}),
    ).toThrow('must be an existing directory');
    await expect(readGitignore({cwd: missing, env: fixture.env})).rejects.toThrow(
      'must be an existing directory',
    );
  });

  it('`allowMissingCwd` reads the rules as if it were an empty directory', async () => {
    const fixture = createFixture({'.gitignore': 'x\n', file: ''});
    fixture.writeInfoExclude('y\n');
    const options = {
      cwd: path.join(fixture.root, 'missing', 'deeper'),
      env: fixture.env,
      allowMissingCwd: true,
    };
    const gitignore = readGitignoreSync(options);

    expect(gitignore.repository?.workTree).toBe(fixture.root);
    expect(gitignore.toEslintIgnores()).toStrictEqual(['**/y', '**/x']);
    expect(gitignore.isIgnored('x')).toBe(true);
    await expect(readGitignore(options)).resolves.toMatchObject({sources: gitignore.sources});
    expect(
      readGitignoreSync({...options, cwd: path.join(fixture.root, 'file')}).toEslintIgnores(),
    ).toStrictEqual(['**/y', '**/x']);
  });
});

describe('outside of a repository', () => {
  it('reads ignore files up to `root`, but not the git-only sources', async () => {
    const fixture = createFixture(
      {'.gitignore': 'top\n', packages: {a: {'.gitignore': 'own\n', sub: {'.gitignore': 'x\n'}}}},
      {gitInit: false},
    );
    fixture.writeGlobalIgnore('global\n');
    const cwd = path.join(fixture.root, 'packages', 'a');
    const gitignore = await readGitignore({cwd, env: fixture.env, root: fixture.root});

    expect(gitignore.repository).toBeUndefined();
    expect(gitignore.toEslintIgnores()).toStrictEqual(['**/top', '**/own', 'sub/**/x']);
    expect(gitignore.isIgnored('sub/deep/x')).toBe(true);
    expect(gitignore.isIgnored(path.join(fixture.root, 'top'))).toBe(true);
  });

  it('`root` must contain `cwd`', () => {
    const fixture = createFixture({a: {}, b: {}}, {gitInit: false});

    expect(() =>
      readGitignoreSync({cwd: path.join(fixture.root, 'a'), root: path.join(fixture.root, 'b')}),
    ).toThrow('must be inside');
  });
});

describe('root option inside a repository', () => {
  it('is relative to `cwd`, like the other paths in the options', () => {
    const fixture = createFixture({
      '.gitignore': 'top\n',
      packages: {'.gitignore': 'middle\n', a: {'.gitignore': 'own\n'}},
    });

    expect(
      readGitignoreSync({
        cwd: path.join(fixture.root, 'packages', 'a'),
        env: fixture.env,
        root: '..',
      }).toEslintIgnores(),
    ).toStrictEqual(['**/middle', '**/own']);
  });

  it('narrows the search, but never goes above the working tree', () => {
    const fixture = createFixture({
      '.gitignore': 'top\n',
      packages: {'.gitignore': 'middle\n', a: {'.gitignore': 'own\n'}},
    });
    const cwd = path.join(fixture.root, 'packages', 'a');

    expect(
      readGitignoreSync({
        cwd,
        env: fixture.env,
        root: path.join(fixture.root, 'packages'),
      }).toEslintIgnores(),
    ).toStrictEqual(['**/middle', '**/own']);
    expect(
      readGitignoreSync({
        cwd,
        env: fixture.env,
        root: path.dirname(fixture.root),
      }).toEslintIgnores(),
    ).toStrictEqual(['**/top', '**/middle', '**/own']);
  });
});

const createMatchingFixture = () =>
  createFixture({
    '.gitignore': ['build/', '*.log', '!important.log', '/packages/*/generated', 'Docs'].join('\n'),
    packages: {a: {generated: {}, src: {}}},
  });

describe('matching', () => {
  it('accepts relative, absolute and URL paths, directories can end with a slash', () => {
    const {root, env} = createMatchingFixture();
    const gitignore = readGitignoreSync({cwd: path.join(root, 'packages'), env});

    expect(gitignore.isIgnored('a/generated/x.ts')).toBe(true);
    expect(gitignore.isIgnored(path.join(root, 'packages', 'a', 'src', 'x.ts'))).toBe(false);
    expect(gitignore.isIgnored(pathToFileURL(path.join(root, 'debug.log')))).toBe(true);
    expect(gitignore.isIgnored('../important.log')).toBe(false);
    expect(gitignore.isIgnored('build')).toBe(false);
    expect(gitignore.isIgnored('build/')).toBe(true);
    expect(gitignore.isIgnored('build', true)).toBe(true);
    expect(gitignore.isIgnored(`build${path.sep}`)).toBe(true);
    expect(gitignore.isIgnored(pathToFileURL(path.join(root, 'build')))).toBe(false);
    expect(gitignore.isIgnored(pathToFileURL(path.join(root, 'build', './')))).toBe(true);
  });

  it('paths outside of the repository and the repository itself are not ignored', () => {
    const {root, env} = createMatchingFixture();
    const gitignore = readGitignoreSync({cwd: root, env});

    expect(gitignore.isIgnored(path.join(path.dirname(root), 'x.log'))).toBe(false);
    expect(gitignore.isIgnored(root)).toBe(false);
  });

  it('`check` explains the result', () => {
    const {root, env} = createMatchingFixture();
    const gitignore = readGitignoreSync({cwd: root, env});

    expect(gitignore.check('build/deep/file.js')).toStrictEqual({
      ignored: true,
      rule: {pattern: 'build/', line: 1, negated: false, directoryOnly: true, anchored: false},
      source: gitignore.sources[0],
      matchedPath: path.join(root, 'build'),
    });
    expect(gitignore.check('important.log')).toMatchObject({
      ignored: false,
      rule: {pattern: '!important.log', line: 3},
      matchedPath: path.join(root, 'important.log'),
    });
    expect(gitignore.check('src/index.ts')).toStrictEqual({ignored: false});
  });

  it('`ignoreCase`', () => {
    const {root, env} = createMatchingFixture();

    expect(readGitignoreSync({cwd: root, env}).isIgnored('docs/a.md')).toBe(false);

    const gitignore = readGitignoreSync({cwd: root, env, ignoreCase: true});

    expect(gitignore.ignoreCase).toBe(true);
    expect(gitignore.isIgnored('docs/a.md')).toBe(true);
    expect(gitignore.isIgnored('BUILD/x')).toBe(true);
    expect(gitignore.isIgnored('Packages/A/Generated/x')).toBe(true);
    // ESLint always matches case-sensitively
    expect(gitignore.toEslintIgnores()).toContain('**/Docs');
  });

  it('`ignoreCase` defaults to `core.ignoreCase`', () => {
    const fixture = createMatchingFixture();

    expect(readGitignoreSync({cwd: fixture.root, env: fixture.env}).ignoreCase).toBe(false);

    fixture.git(['config', 'core.ignoreCase', 'true']);
    const gitignore = readGitignoreSync({
      cwd: fixture.root,
      env: fixture.env,
      // The config must be read even without the global ignore file
      sources: {globalIgnoreFile: false},
    });

    expect(gitignore.ignoreCase).toBe(true);
    expect(gitignore.isIgnored('docs/a.md')).toBe(true);
    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env, ignoreCase: false}).ignoreCase,
    ).toBe(false);
  });

  // So paths must only be split on `\` on Windows
  it.skipIf(process.platform === 'win32')(
    'a backslash in a name is not a separator outside of Windows, like in git',
    () => {
      const fixture = createFixture({
        // An escaped backslash
        '.gitignore': `${String.raw`a\\b`}\n`,
        [String.raw`x\y`]: {'.gitignore': 'z\n'},
      });
      const gitignore = readGitignoreSync({cwd: fixture.root, env: fixture.env});
      const paths = [String.raw`a\b`, 'a/b', String.raw`x\y/z`, 'x/y/z'];

      expect(paths.map((value) => gitignore.isIgnored(value))).toStrictEqual([
        true,
        false,
        true,
        false,
      ]);
      expect(gitCheckIgnore(fixture, paths).map((result) => result.ignored)).toStrictEqual([
        true,
        false,
        true,
        false,
      ]);
    },
  );

  it('matches bytes, like git', () => {
    const fixture = createFixture({'.gitignore': '?.txt\nd??/\n[!a]\n'});
    const gitignore = readGitignoreSync({cwd: fixture.root, env: fixture.env});

    // `ё` and `é` are two bytes each
    expect(gitignore.isIgnored('ё.txt')).toBe(false);
    expect(gitignore.isIgnored('é')).toBe(false);
    expect(gitignore.check('dé/x')).toMatchObject({
      ignored: true,
      rule: {pattern: 'd??/'},
      matchedPath: path.join(fixture.root, 'dé'),
    });
    expect(gitignore.check('dx/y')).toMatchObject({
      ignored: true,
      rule: {pattern: '[!a]'},
      matchedPath: path.join(fixture.root, 'dx', 'y'),
    });
  });

  it('`ignoreCase` is off outside of a repository', () => {
    const fixture = createFixture({'.gitignore': 'Docs\n'}, {gitInit: false});

    expect(readGitignoreSync({cwd: fixture.root, env: fixture.env}).ignoreCase).toBe(false);
  });
});

describe('toEslintIgnores', () => {
  it('directory names are escaped', () => {
    const fixture = createFixture({
      app: {'[id]': {'.gitignore': '*.gen.ts\n'}, '(group)': {'{a,b}': {'.gitignore': 'x\n'}}},
    });

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual([
      String.raw`app/\[id[\]]/**/*.gen.ts`,
      String.raw`app/\(group[\)]/[\{]a,b[\}]/**/x`,
    ]);
  });

  it('anchored rules of the parents are rebased', () => {
    const fixture = createFixture({
      '.gitignore': [
        '/packages/a/dist',
        '/packages/b/dist',
        'packages/*/cache/',
        'packages/**/tmp',
        '/packages/a',
        '!/packages/a/keep',
        '/packages/a/**',
        '**/logs',
      ].join('\n'),
      packages: {a: {}},
    });

    expect(
      readGitignoreSync({
        cwd: path.join(fixture.root, 'packages', 'a'),
        env: fixture.env,
      }).toEslintIgnores(),
    ).toStrictEqual(['dist', 'cache/', '**/tmp', '!keep', '**', '**/logs']);
  });

  it("trailing `/**` doesn't match the directory itself", () => {
    const fixture = createFixture({'.gitignore': 'a/**\n!a/b\n', sub: {'.gitignore': '/**\n'}});

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual(['a/**/*', '!a/b', 'sub/**/*']);
  });

  it('rules that can never match are left out, duplicates are removed', () => {
    const fixture = createFixture({
      '.gitignore': ['a[', 'b\\', '[/]', 'dup', 'other', 'dup', '[!/]x'].join('\n'),
    });

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual([
      '**/other',
      '**/dup',
      // Anchored because of the slash
      '?x',
    ]);
  });
});

describe('worktree config', () => {
  it('is only read with `extensions.worktreeConfig`', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.home, 'from-worktree'), 'x\n');
    fs.writeFileSync(
      path.join(fixture.root, '.git', 'config.worktree'),
      `[core]\nexcludesFile = ${JSON.stringify(path.join(fixture.home, 'from-worktree'))}\n`,
    );

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual([]);

    fs.appendFileSync(
      path.join(fixture.root, '.git', 'config'),
      '[extensions]\n\tworktreeConfig\n',
    );

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual(['**/x']);
  });
});

describe('order', () => {
  it("doesn't depend on the order of directory entries", () => {
    const fixture = createFixture();
    // Created in the reverse order
    ['c', 'b', 'a'].forEach((name) => {
      fixture.write({[name]: {'.gitignore': `${name}-ignored\n`, sub: {'.gitignore': 'x\n'}}});
    });

    expect(
      readGitignoreSync({cwd: fixture.root, env: fixture.env}).toEslintIgnores(),
    ).toStrictEqual([
      'a/**/a-ignored',
      'b/**/b-ignored',
      'c/**/c-ignored',
      'a/sub/**/x',
      'b/sub/**/x',
      'c/sub/**/x',
    ]);
  });
});

describe('sources.files', () => {
  it('reads the files like ignore files in their directories, after the other ones', () => {
    const fixture = createFixture({
      '.gitignore': 'a\nignored/\n',
      '.eslintignore': '!a\nb\n',
      sub: {'.gitignore': '*.log\n', 'extra-ignore': '!keep.log\n'},
      ignored: {'extra-ignore': 'useless\n'},
    });
    const gitignore = readGitignoreSync({
      cwd: fixture.root,
      env: fixture.env,
      sources: {
        files: [
          '.eslintignore',
          pathToFileURL(path.join(fixture.root, 'sub', 'extra-ignore')),
          'ignored/extra-ignore',
        ],
      },
    });

    expect(
      gitignore.sources.map((source) => path.relative(fixture.root, source.path || '')),
    ).toStrictEqual([
      '.gitignore',
      '.eslintignore',
      path.join('sub', '.gitignore'),
      path.join('sub', 'extra-ignore'),
      // Read after the search, though the directory is ignored anyway
      path.join('ignored', 'extra-ignore'),
    ]);
    expect(gitignore.isIgnored('a')).toBe(false);
    expect(gitignore.isIgnored('sub/x.log')).toBe(true);
    expect(gitignore.isIgnored('sub/keep.log')).toBe(false);
    expect(gitignore.toEslintIgnores()).toStrictEqual([
      '**/a',
      '**/ignored/',
      '!**/a',
      '**/b',
      'sub/**/*.log',
      '!sub/**/keep.log',
      'ignored/**/useless',
    ]);
  });

  it("are read even if their directories aren't searched, but not outside of `root`", () => {
    const fixture = createFixture({
      outside: {'.eslintignore': 'never-read\n'},
      project: {
        sub: {'.eslintignore': 'a\n'},
        node_modules: {'.eslintignore': 'b\n'},
      },
    });
    const gitignore = readGitignoreSync({
      cwd: path.join(fixture.root, 'project'),
      root: path.join(fixture.root, 'project'),
      env: fixture.env,
      sources: {
        nested: false,
        files: ['sub/.eslintignore', 'node_modules/.eslintignore', '../outside/.eslintignore'],
      },
    });

    expect(gitignore.toEslintIgnores()).toStrictEqual(['sub/**/a', 'node_modules/**/b']);
    expect(gitignore.isIgnored('sub/a')).toBe(true);
  });
});

describe('includeIf "gitdir:"', () => {
  it('`./` is relative to the real path of the config file', (context) => {
    const fixture = createFixture({'a.log': ''});
    // Next to the repository, unlike the symlink to it
    const realConfigPath = path.join(path.dirname(fixture.root), 'gitconfig');
    fs.writeFileSync(realConfigPath, '[includeIf "gitdir:./repo/"]\npath = ~/included.gitconfig\n');
    symlinkOrSkip(realConfigPath, fixture.env.GIT_CONFIG_GLOBAL, context);
    fs.writeFileSync(path.join(fixture.home, 'included.gitconfig'), '[core]\nexcludesFile = ~/x\n');
    fs.writeFileSync(path.join(fixture.home, 'x'), '*.log\n');

    expect(fixture.git(['check-ignore', 'a.log'])).toBe('a.log\n');
    expect(readGitignoreSync({cwd: fixture.root, env: fixture.env}).isIgnored('a.log')).toBe(true);
  });

  it('`~/` is the real path of the home directory', (context) => {
    const fixture = createFixture();
    const homeLink = path.join(path.dirname(fixture.root), 'home-link');
    symlinkOrSkip(fixture.home, homeLink, context);
    const project = path.join(fixture.home, 'project');
    fs.mkdirSync(project);
    const env = {...fixture.env, HOME: homeLink};
    fixture.git(['init', '--quiet'], {cwd: project});
    fs.writeFileSync(
      env.GIT_CONFIG_GLOBAL,
      '[includeIf "gitdir:~/project/"]\npath = ~/included.gitconfig\n',
    );
    fs.writeFileSync(path.join(fixture.home, 'included.gitconfig'), '[core]\nexcludesFile = ~/x\n');
    fs.writeFileSync(path.join(fixture.home, 'x'), '*.log\n');

    expect(fixture.git(['check-ignore', '--no-index', 'a.log'], {cwd: project, env})).toBe(
      'a.log\n',
    );
    expect(readGitignoreSync({cwd: project, env}).isIgnored('a.log')).toBe(true);
  });

  it('matches the real path of the git directory too', (context) => {
    const fixture = createFixture();
    const link = path.join(fixture.home, 'link');
    symlinkOrSkip(fixture.root, link, context);
    fs.writeFileSync(
      fixture.env.GIT_CONFIG_GLOBAL,
      // Backslashes would be dropped in a quoted subsection
      `[includeIf "gitdir:${toForwardSlashes(fixture.root)}/"]\npath = included.gitconfig\n`,
    );
    fs.writeFileSync(path.join(fixture.home, 'included.gitconfig'), '[core]\nexcludesFile = ~/x\n');
    fs.writeFileSync(path.join(fixture.home, 'x'), '*.log\n');

    expect(readGitignoreSync({cwd: link, env: fixture.env}).isIgnored('a.log')).toBe(true);
    expect(fixture.git(['check-ignore', 'a.log'], {cwd: link})).toBe('a.log\n');
  });
});
