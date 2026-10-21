import {RuleConfigSeverity, type UserConfig} from '@commitlint/types';

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-leading-blank': [RuleConfigSeverity.Error, 'always'],
    'body-max-line-length': [RuleConfigSeverity.Disabled],
    'footer-leading-blank': [RuleConfigSeverity.Error, 'always'],
    'header-max-length': [RuleConfigSeverity.Error, 'always', 120],
    'subject-full-stop': [RuleConfigSeverity.Disabled], // Sometimes full stop is used for shorthands
    // `sentence-case`, `start-case` sometimes useful if commit message starts with a proper name
    'subject-case': [RuleConfigSeverity.Error, 'never', ['pascal-case', 'upper-case']],
  },
} satisfies UserConfig;
