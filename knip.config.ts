import type {KnipConfig} from 'knip';

export default {
  entry: ['.ncurc.js'], // cspell:disable-line
  tags: ['-knipignore'],
  treatConfigHintsAsErrors: true,
} satisfies KnipConfig;
