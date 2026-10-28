import {eslintConfig} from 'eslint-config-un';
import oxfmtConfig from './oxfmt.config.ts';

export default eslintConfig({
  ignores: ['.agents/guidelines.md', 'CHANGELOG.md'],
  mode: 'lib',
  defaultConfigsStatus: 'misc-enabled',
  configs: {
    format: {
      // Only Markdown code blocks, other files are formatted by the formatter itself
      files: [],
      configFencedCodeBlocks: true,
      formatter: [
        'oxfmt',
        {
          bracketSpacing: oxfmtConfig.bracketSpacing,
          printWidth: oxfmtConfig.printWidth,
          singleQuote: oxfmtConfig.singleQuote,
        },
      ],
    },
    import: {
      requireModuleExtensions: true,
      // The test helpers in `test/utils.ts` may import dev dependencies too
      extraneousDependenciesCheck: (defaultIgnorePatterns) => ({
        checkDevDependencies: {ignorePatterns: [...defaultIgnorePatterns, 'test/**']},
        // Bundled by tsdown
        whitelist: ['utilery'],
      }),
    },
    jsdoc: {
      overrides: {
        // The generators here are quansync ones: what they yield is internal, callers only get
        // the return value
        'jsdoc/require-yields': 0,
      },
    },
    markdown: {
      configSentencesPerLine: true,
    },
    nodeDependencies: {
      enforceAbsoluteVersion: 'always',
      overrides: {
        'node-dependencies/compat-engines': [2, {devDependencies: false}],
      },
    },
    unicorn: {
      overrides: {
        // Conflicts with `ts/consistent-return`, which requires `return undefined` in functions that
        // return a value elsewhere
        'unicorn/no-useless-undefined': 0,
      },
    },

    // False positives:
    zod: false,
  },
  extraConfigs: [],
});
