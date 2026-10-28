// @ts-check
import {ncuConfig} from '@andreww2012/npm-check-updates-config';

export default ncuConfig({
  // eslint-disable-next-line node/no-unsupported-features/node-builtins
  cwd: import.meta.dirname,
  targets: {
    // Their `latest` dist-tag lags behind the prerelease channel we actually follow
    'eslint-config-un': 'greatest',
  },
  groups: {
    // '@commitlint': {},
  },
});
