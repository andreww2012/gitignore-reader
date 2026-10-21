import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // ESLint forbids importing them
    globals: true,
  },
});
