import { createStore } from '@bundled/solid-js/store';
import type {
  Section, RepoRef, RateLimit, Repo, Issue, Comment, Pull, CommitItem, Release, ContentEntry,
  GHUser, AuthState,
} from './types';

export const DEFAULT_REPO: RepoRef = { owner: 'sorryhyun', name: 'yaar' };

export const [state, setState] = createStore({
  // Navigation
  section: 'overview' as Section,

  // Repo + auth
  repo: { ...DEFAULT_REPO } as RepoRef,
  token: '' as string,
  user: null as GHUser | null,
  auth: { status: 'idle', userCode: '', verificationUri: '', error: '' } as AuthState,
  rateLimit: null as RateLimit | null,

  // Global
  loading: false,
  error: '' as string,

  // Overview
  repoInfo: null as Repo | null,
  readmeHtml: '' as string,
  readmeMissing: false,

  // Issues
  issues: [] as Issue[],
  issuesLoading: false,
  issueFilter: 'open' as 'open' | 'closed',
  issueSearch: '' as string,
  activeIssue: null as Issue | null,
  activeIssueComments: [] as Comment[],
  issueDetailLoading: false,
  mutating: false,

  // New-issue modal
  showNewIssue: false,

  // Pull requests
  pulls: [] as Pull[],
  pullsLoading: false,
  pullFilter: 'open' as 'open' | 'closed',
  activePull: null as Pull | null,
  activePullCommits: [] as CommitItem[],
  activePullComments: [] as Comment[],
  pullDetailLoading: false,

  // Releases
  releases: [] as Release[],
  releasesLoading: false,

  // Code browser
  codePath: '' as string,
  codeEntries: [] as ContentEntry[],
  codeLoading: false,
  fileName: '' as string,
  fileHtml: '' as string,
  fileText: '' as string,
  fileIsMarkdown: false,
  fileBinary: false,
  fileDownloadUrl: '' as string,
});

/** Whether an OAuth access token is present (i.e. the user is signed in). */
export function hasToken(): boolean {
  return state.token.trim().length > 0;
}

export { showToast } from '@bundled/yaar';
