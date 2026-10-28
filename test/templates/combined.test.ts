import path from 'node:path';
import {readGitignoreSync} from '../../src/index.ts';
import {compareWithEslint, compareWithGit, createFixture} from '../utils.ts';
import {
  createCandidatePathsForContent,
  createPaths,
  hasTemplates,
  readTemplate,
  templates,
} from './utils.ts';

const TIMEOUT_MS = 600_000;
const GITIGNORE_EXTENSION_REGEX = /\.gitignore$/;

describe.runIf(hasTemplates)('github/gitignore templates', () => {
  it('has the templates', () => {
    expect(templates.length).toBeGreaterThan(100);
  });

  // Not checked with cspell: it would take minutes with thousands of patterns, and the templates
  // are checked with it one by one anyway
  it(
    'all of them at once, with every source',
    async () => {
      const fixture = createFixture();
      const contents = templates.map((template) => ({
        directory: path.join('t', template.replace(GITIGNORE_EXTENSION_REGEX, '')),
        content: readTemplate(template),
      }));
      contents.forEach(({directory, content}) => {
        fixture.write({[path.join(directory, '.gitignore')]: content});
        createPaths(
          path.join(fixture.root, directory),
          createCandidatePathsForContent(content),
          150,
        );
      });
      fixture.write({'.gitignore': readTemplate('Node.gitignore')});
      fixture.writeInfoExclude(readTemplate(path.join('Global', 'JetBrains.gitignore')));
      fixture.writeGlobalIgnore(readTemplate(path.join('Global', 'macOS.gitignore')));

      const comparison = compareWithGit(
        fixture,
        readGitignoreSync({cwd: fixture.root, env: fixture.env, sources: {globalIgnoreFile: true}}),
      );

      expect(comparison.entries.length).toBeGreaterThan(10_000);
      expect(comparison.mismatches).toStrictEqual([]);
      await expect(compareWithEslint(fixture, fixture.root, comparison)).resolves.toStrictEqual([]);
    },
    TIMEOUT_MS,
  );
});
