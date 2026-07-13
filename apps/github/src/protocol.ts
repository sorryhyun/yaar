import { app, AppCommandError, defineCommand, errMsg } from '@bundled/yaar';
import { state, hasToken } from './store';

function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    throw new AppCommandError(errMsg(e));
  });
}
import {
  setRepoAction,
  refreshAll,
  createIssueAction,
  commentIssueAction,
  setIssueStateAction,
} from './actions';
import { startDeviceLogin, signOut } from './auth';

function issueSummary() {
  return state.issues.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    labels: i.labels.map((l) => l.name),
    comments: i.comments,
    author: i.user?.login,
    url: i.html_url,
  }));
}

function pullSummary() {
  return state.pulls.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    merged: p.merged,
    author: p.user?.login,
    url: p.html_url,
  }));
}

export function registerAppProtocol(): void {
  if (!app) return;

  app.register({
    appId: 'github',
    name: 'GitHub',
    state: {
      repo: {
        description: 'The active repository (owner/name), sign-in state, and signed-in user login',
        handler: () => ({
          owner: state.repo.owner,
          name: state.repo.name,
          signedIn: hasToken(),
          user: state.user?.login ?? null,
        }),
      },
      issues: {
        description: 'Currently loaded issues (respecting the open/closed filter)',
        handler: () => issueSummary(),
      },
      activeIssue: {
        description: 'The currently opened issue with body and comments, or null',
        handler: () => {
          const i = state.activeIssue;
          if (!i) return null;
          return {
            number: i.number,
            title: i.title,
            state: i.state,
            body: i.body,
            labels: i.labels.map((l) => l.name),
            author: i.user?.login,
            url: i.html_url,
            comments: state.activeIssueComments.map((c) => ({
              author: c.user?.login,
              body: c.body,
              created_at: c.created_at,
            })),
          };
        },
      },
      pulls: {
        description: 'Currently loaded pull requests (respecting the open/closed filter)',
        handler: () => pullSummary(),
      },
      releases: {
        description: 'Loaded releases with tag, notes and assets',
        handler: () =>
          state.releases.map((r) => ({
            tag: r.tag_name,
            name: r.name,
            published_at: r.published_at,
            prerelease: r.prerelease,
            url: r.html_url,
            assets: r.assets.map((a) => ({
              name: a.name,
              url: a.browser_download_url,
              downloads: a.download_count,
            })),
          })),
      },
      readme: {
        description: 'The rendered README for the active repo: markdown source, rendered HTML and whether it is missing',
        handler: () => ({
          missing: state.readmeMissing,
          markdown: state.readmeMarkdown,
          html: state.readmeHtml,
          length: state.readmeMarkdown.length,
        }),
      },
      rateLimit: {
        description: 'GitHub API rate-limit info from the last response',
        handler: () => (state.rateLimit ? { ...state.rateLimit } : null),
      },
    },
    commands: {
      setRepo: defineCommand({
        description: 'Switch the active repository and persist it',
        params: {
          type: 'object',
          properties: { owner: { type: 'string' }, name: { type: 'string' } },
          required: ['owner', 'name'],
        },
        handler: (p) =>
          guard(async () => {
            await setRepoAction(String(p.owner), String(p.name));
            return { repo: `${state.repo.owner}/${state.repo.name}` };
          }),
      }),
      refresh: defineCommand({
        description: 'Reload data for the current section',
        params: { type: 'object', properties: {} },
        handler: () =>
          guard(async () => {
            await refreshAll();
            return { ok: true };
          }),
      }),
      createIssue: defineCommand({
        description: 'Create a new issue (requires sign-in)',
        params: {
          type: 'object',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title'],
        },
        handler: (p) => guard(() => createIssueAction(String(p.title), String(p.body || ''))),
      }),
      commentIssue: defineCommand({
        description: 'Add a comment to an issue (requires sign-in)',
        params: {
          type: 'object',
          properties: { number: { type: 'number' }, body: { type: 'string' } },
          required: ['number', 'body'],
        },
        handler: (p) =>
          guard(async () => {
            await commentIssueAction(Number(p.number), String(p.body));
            return { ok: true };
          }),
      }),
      closeIssue: defineCommand({
        description: 'Close an issue (requires sign-in)',
        params: {
          type: 'object',
          properties: { number: { type: 'number' } },
          required: ['number'],
        },
        handler: (p) =>
          guard(async () => {
            await setIssueStateAction(Number(p.number), 'closed');
            return { ok: true };
          }),
      }),
      reopenIssue: defineCommand({
        description: 'Reopen a closed issue (requires sign-in)',
        params: {
          type: 'object',
          properties: { number: { type: 'number' } },
          required: ['number'],
        },
        handler: (p) =>
          guard(async () => {
            await setIssueStateAction(Number(p.number), 'open');
            return { ok: true };
          }),
      }),
      signIn: defineCommand({
        description:
          'Start GitHub sign-in via the OAuth device flow. Returns a userCode and verificationUri — ' +
          'tell the user to open the URL and enter the code; the app completes sign-in once they authorize.',
        params: { type: 'object', properties: {} },
        handler: () =>
          guard(async () => {
            const { userCode, verificationUri } = await startDeviceLogin();
            return { userCode, verificationUri };
          }),
      }),
      signOut: defineCommand({
        description: 'Sign out of GitHub and clear the stored token',
        params: { type: 'object', properties: {} },
        handler: () =>
          guard(async () => {
            await signOut();
            return { signedIn: hasToken() };
          }),
      }),
    },
  });
}
