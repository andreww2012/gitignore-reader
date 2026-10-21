import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: 'src/index.ts',
  dts: true,
  exports: true,
  deps: {
    // A dev dependency: only the few functions in use end up in the bundle
    onlyBundle: ['@andreww2012/unutils'],
    onlyImport: ['quansync'],
  },
  // The docs are in the declarations, and the bundled functions have long ones
  outputOptions: {comments: {legal: true, annotation: true, jsdoc: false}},
});
