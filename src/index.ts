export type {
  Gitignore,
  GitignoreCheckResult,
  GitignoreSource,
  GitignoreSourceType,
} from './gitignore.ts';
export type {GitignoreRule} from './pattern.ts';
export {
  type GitignoreSourcesOptions,
  type ReadGitignoreOptions,
  readGitignore,
  readGitignoreSync,
} from './read.ts';
export type {GitRepository} from './repository.ts';
