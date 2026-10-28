import {TEMPLATE_TIMEOUT_MS, getTemplateShard, hasTemplates, testTemplate} from './utils.ts';

describe.runIf(hasTemplates)('github/gitignore templates', () => {
  // eslint-disable-next-line vitest/expect-expect -- the assertions are in the shared test function
  it.each(getTemplateShard(1))('%s', testTemplate, TEMPLATE_TIMEOUT_MS);
});
