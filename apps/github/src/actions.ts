import { errMsg, showToast } from '@bundled/yaar';
import type { Issue, Pull, RepoRef, ContentEntry, AccountRepo } from './types';
import { state, setState, hasToken } from './store';
import { renderRepoMarkdown, decodeBase64Utf8 } from './markdown';
import { writeConfig, ready } from './storage';
import * as api from './api';

const SIGN_IN_REQUIRED = 'Sign in to GitHub (Settings) to ';

/**
 * Bumped whenever the active repository changes. Loaders capture it before
 * fetching and drop their result if it moved on, so a slow response for the
 * previous repo can never clobber the current repo's state.
 */
let repoGen = 0;
const stale = (gen: number): boolean => gen !== repoGen;

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
const TEXT_EXT = /\.(ts|tsx|js|jsx|json|css|scss|html|xml|yml|yaml|txt|py|rb|go|rs|java|c|h|cpp|cc|sh|toml|ini|cfg|env|sql|graphql|svg|lock|gitignore|editorconfig|dockerfile|makefile)$/i;

// ── Overview ────────────────────────────────────────────────────
export async function loadOverview(): Promise<void> {
  await ready();
  const gen = repoGen;
  setState('loading', true);
  setState('error', '');
  try {
    const repo = await api.fetchRepo();
    if (stale(gen)) return;
    setState('repoInfo', repo);
    try {
      const readme = await api.fetchReadme();
      if (stale(gen)) return;
      if (readme && readme.encoding === 'base64') {
        const md = decodeBase64Utf8(readme.content);
        setState('readmeMarkdown', md);
        // repoInfo is set above, so default_branch is available for path rewriting.
        setState('readmeHtml', renderRepoMarkdown(md));
        setState('readmeMissing', false);
      } else {
        setState('readmeMarkdown', '');
        setState('readmeHtml', '');
        setState('readmeMissing', true);
      }
    } catch {
      if (stale(gen)) return;
      setState('readmeHtml', '');
      setState('readmeMissing', true);
    }
  } catch (e) {
    if (stale(gen)) return;
    setState('repoInfo', null);
    setState('error', errMsg(e));
  } finally {
    if (!stale(gen)) setState('loading', false);
  }
}

// ── Issues ───────────────────────────────────────────────────
export async function loadIssues(): Promise<Issue[]> {
  await ready();
  const gen = repoGen;
  setState('issuesLoading', true);
  setState('error', '');
  try {
    const issues = await api.fetchIssues(state.issueFilter);
    if (stale(gen)) return issues;
    setState('issues', issues);
    return issues;
  } catch (e) {
    if (stale(gen)) return [];
    setState('issues', []);
    setState('error', errMsg(e));
    return [];
  } finally {
    if (!stale(gen)) setState('issuesLoading', false);
  }
}

export function setIssueFilter(filter: 'open' | 'closed'): void {
  if (state.issueFilter === filter) return;
  setState('issueFilter', filter);
  void loadIssues();
}

export async function openIssue(number: number): Promise<void> {
  setState('issueDetailLoading', true);
  const existing = state.issues.find((i) => i.number === number) || null;
  setState('activeIssue', existing);
  setState('activeIssueComments', []);
  try {
    const [issue, comments] = await Promise.all([
      api.fetchIssue(number),
      api.fetchIssueComments(number),
    ]);
    setState('activeIssue', issue);
    setState('activeIssueComments', comments);
  } catch (e) {
    showToast(errMsg(e), 'error');
  } finally {
    setState('issueDetailLoading', false);
  }
}

export function closeActiveIssue(): void {
  setState('activeIssue', null);
  setState('activeIssueComments', []);
}

export async function createIssueAction(title: string, body: string): Promise<{ number: number }> {
  await ready();
  if (!hasToken()) throw new Error(`${SIGN_IN_REQUIRED}create issues.`);
  if (!title.trim()) throw new Error('Issue title is required.');
  setState('mutating', true);
  try {
    const issue = await api.createIssue(title.trim(), body);
    showToast(`Created issue #${issue.number}`, 'success');
    setState('issueFilter', 'open');
    await loadIssues();
    await openIssue(issue.number);
    return { number: issue.number };
  } finally {
    setState('mutating', false);
  }
}

export async function commentIssueAction(number: number, body: string): Promise<void> {
  await ready();
  if (!hasToken()) throw new Error(`${SIGN_IN_REQUIRED}comment.`);
  if (!body.trim()) throw new Error('Comment body is required.');
  setState('mutating', true);
  try {
    await api.createComment(number, body.trim());
    const comments = await api.fetchIssueComments(number);
    setState('activeIssueComments', comments);
    showToast('Comment posted', 'success');
  } finally {
    setState('mutating', false);
  }
}

export async function setIssueStateAction(number: number, newState: 'open' | 'closed'): Promise<void> {
  await ready();
  if (!hasToken()) throw new Error(`${SIGN_IN_REQUIRED}change issue state.`);
  setState('mutating', true);
  try {
    const issue = await api.setIssueState(number, newState);
    setState('activeIssue', issue);
    showToast(newState === 'closed' ? `Closed #${number}` : `Reopened #${number}`, 'success');
    await loadIssues();
  } finally {
    setState('mutating', false);
  }
}

// ── Pull requests ───────────────────────────────────────────────
export async function loadPulls(): Promise<Pull[]> {
  await ready();
  const gen = repoGen;
  setState('pullsLoading', true);
  setState('error', '');
  try {
    const pulls = await api.fetchPulls(state.pullFilter);
    if (stale(gen)) return pulls;
    setState('pulls', pulls);
    return pulls;
  } catch (e) {
    if (stale(gen)) return [];
    setState('pulls', []);
    setState('error', errMsg(e));
    return [];
  } finally {
    if (!stale(gen)) setState('pullsLoading', false);
  }
}

export function setPullFilter(filter: 'open' | 'closed'): void {
  if (state.pullFilter === filter) return;
  setState('pullFilter', filter);
  void loadPulls();
}

export async function openPull(number: number): Promise<void> {
  setState('pullDetailLoading', true);
  const existing = state.pulls.find((p) => p.number === number) || null;
  setState('activePull', existing);
  setState('activePullCommits', []);
  setState('activePullComments', []);
  try {
    const [pull, commits, comments] = await Promise.all([
      api.fetchPull(number),
      api.fetchPullCommits(number),
      api.fetchPullComments(number),
    ]);
    setState('activePull', pull);
    setState('activePullCommits', commits);
    setState('activePullComments', comments);
  } catch (e) {
    showToast(errMsg(e), 'error');
  } finally {
    setState('pullDetailLoading', false);
  }
}

export function closeActivePull(): void {
  setState('activePull', null);
  setState('activePullCommits', []);
  setState('activePullComments', []);
}

// ── Releases ────────────────────────────────────────────────────
export async function loadReleases(): Promise<void> {
  await ready();
  const gen = repoGen;
  setState('releasesLoading', true);
  setState('error', '');
  try {
    const releases = await api.fetchReleases();
    if (stale(gen)) return;
    setState('releases', releases);
  } catch (e) {
    if (stale(gen)) return;
    setState('releases', []);
    setState('error', errMsg(e));
  } finally {
    if (!stale(gen)) setState('releasesLoading', false);
  }
}

// ── Code browser ───────────────────────────────────────────────
function resetFileView(): void {
  setState('fileName', '');
  setState('fileHtml', '');
  setState('fileText', '');
  setState('fileIsMarkdown', false);
  setState('fileBinary', false);
  setState('fileDownloadUrl', '');
}

export async function loadDir(path: string): Promise<void> {
  await ready();
  const gen = repoGen;
  setState('codeLoading', true);
  setState('error', '');
  resetFileView();
  try {
    const result = await api.fetchContents(path);
    if (stale(gen)) return;
    const entries = (Array.isArray(result) ? result : [result]) as ContentEntry[];
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    setState('codeEntries', entries);
    setState('codePath', path.replace(/^\/+|\/+$/g, ''));
  } catch (e) {
    if (stale(gen)) return;
    setState('codeEntries', []);
    setState('error', errMsg(e));
  } finally {
    if (!stale(gen)) setState('codeLoading', false);
  }
}

export async function openFile(entry: ContentEntry): Promise<void> {
  setState('codeLoading', true);
  try {
    const file = await api.fetchFileContent(entry.path);
    setState('fileName', file.name);
    setState('fileDownloadUrl', file.download_url || '');
    const isMd = MARKDOWN_EXT.test(file.name);
    const isText = isMd || TEXT_EXT.test(file.name) || /^(readme|license|makefile|dockerfile)$/i.test(file.name);
    if (file.encoding === 'base64' && isText && file.size < 512 * 1024) {
      const text = decodeBase64Utf8(file.content);
      setState('fileText', text);
      setState('fileIsMarkdown', isMd);
      // Resolve the file's own directory so its relative links/images work too.
      const fileDir = entry.path.split('/').slice(0, -1).join('/');
      setState('fileHtml', isMd ? renderRepoMarkdown(text, fileDir) : '');
      setState('fileBinary', false);
    } else {
      setState('fileBinary', true);
      setState('fileText', '');
      setState('fileHtml', '');
    }
  } catch (e) {
    showToast(errMsg(e), 'error');
  } finally {
    setState('codeLoading', false);
  }
}

export function closeFile(): void {
  resetFileView();
}

export function goUpDir(): void {
  const parts = state.codePath.split('/').filter(Boolean);
  parts.pop();
  void loadDir(parts.join('/'));
}

export function navigateCrumb(index: number): void {
  const parts = state.codePath.split('/').filter(Boolean).slice(0, index + 1);
  void loadDir(parts.join('/'));
}

// ── Repo + token management ───────────────────────────────────────
export function resetRepoData(): void {
  setState('repoInfo', null);
  setState('readmeHtml', '');
  setState('readmeMissing', false);
  setState('issues', []);
  closeActiveIssue();
  setState('pulls', []);
  closeActivePull();
  setState('releases', []);
  setState('codePath', '');
  setState('codeEntries', []);
  resetFileView();
}

export async function setRepoAction(owner: string, name: string): Promise<void> {
  const o = owner.trim();
  const n = name.trim();
  if (!o || !n) throw new Error('Both owner and repository name are required.');
  const repo: RepoRef = { owner: o, name: n };
  await writeConfig(repo);
  // Invalidate any in-flight fetches for the previous repo before resetting.
  repoGen += 1;
  resetRepoData();
  await loadSection(state.section, true);
  showToast(`Switched to ${o}/${n}`, 'success');
}

export async function loadAccountRepos(force = false): Promise<AccountRepo[]> {
  await ready();
  if (!hasToken()) {
    setState('repoPickerError', 'Sign in from Settings to browse your repositories.');
    return [];
  }
  if (state.accountReposLoaded && !force) return state.accountRepos;
  setState('accountReposLoading', true);
  setState('repoPickerError', '');
  try {
    const repos = await api.fetchUserRepos();
    setState('accountRepos', repos);
    setState('accountReposLoaded', true);
    return repos;
  } catch (e) {
    setState('repoPickerError', errMsg(e));
    return [];
  } finally {
    setState('accountReposLoading', false);
  }
}

export function toggleRepoPicker(): void {
  const open = !state.repoPickerOpen;
  setState('repoPickerOpen', open);
  if (open) void loadAccountRepos();
}

export function closeRepoPicker(): void {
  setState('repoPickerOpen', false);
  setState('repoSearch', '');
}

export async function selectAccountRepo(repo: AccountRepo): Promise<void> {
  closeRepoPicker();
  await setRepoAction(repo.owner.login, repo.name);
}

export async function refreshAll(): Promise<void> {
  resetRepoData();
  await loadSection(state.section, true);
}

// ── Section loader ───────────────────────────────────────────────
export async function loadSection(section: import('./types').Section, force = false): Promise<void> {
  // Wait for the persisted repo + token before deciding what (and where) to fetch.
  await ready();
  switch (section) {
    case 'overview':
      if (force || !state.repoInfo) await loadOverview();
      break;
    case 'issues':
      if (force || state.issues.length === 0) await loadIssues();
      break;
    case 'pulls':
      if (force || state.pulls.length === 0) await loadPulls();
      break;
    case 'releases':
      if (force || state.releases.length === 0) await loadReleases();
      break;
    case 'code':
      if (force || state.codeEntries.length === 0) await loadDir(force ? '' : state.codePath);
      break;
    case 'settings':
      break;
  }
}

export function selectSection(section: import('./types').Section): void {
  setState('section', section);
  void loadSection(section);
}
