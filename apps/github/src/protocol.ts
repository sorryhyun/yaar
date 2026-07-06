import { app, AppCommandError, errMsg } from '@bundled/yaar';
import { state, hasToken } from './store';

function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => { throw new AppCommandError(errMsg(e)); });
}
import {
  setRepoAction, refreshAll, createIssueAction, commentIssueAction,
  setIssueStateAction, setTokenAction,
} from './actions';

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
        description: 'The active repository (owner/name) and whether a token is set',
        handler: () => ({ owner: state.repo.owner, name: state.repo.name, hasToken: hasToken() }),
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
            comments: state.activeIssueComments.map((c) => ({ author: c.user?.login, body: c.body, created_at: c.created_at })),
          };
        },
      },
      pulls: {
        description: 'Currently loaded pull requests (respecting the open/closed filter)',
        handler: () => pullSummary(),
      },
      releases: {
        description: 'Loaded releases with tag, notes and assets',
        handler: () => state.releases.map((r) => ({
          tag: r.tag_name,
          name: r.name,
          published_at: r.published_at,
          prerelease: r.prerelease,
          url: r.html_url,
          assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, downloads: a.download_count })),
        })),
      },
      rateLimit: {
        description: 'GitHub API rate-limit info from the last response',
        handler: () => (state.rateLimit ? { ...state.rateLimit } : null),
      },
    },
    commands: {
      setRepo: {
        description: 'Switch the active repository and persist it',
        params: {
          type: 'object',
          properties: { owner: { type: 'string' }, name: { type: 'string' } },
          required: ['owner', 'name'],
        },
        handler: (p: Record<string, unknown>) => guard(async () => {
          await setRepoAction(String(p.owner), String(p.name));
          return { repo: `${state.repo.owner}/${state.repo.name}` };
        }),
      },
      refresh: {
        description: 'Reload data for the current section',
        params: { type: 'object', properties: {} },
        handler: () => guard(async () => { await refreshAll(); return { ok: true }; }),
      },
      createIssue: {
        description: 'Create a new issue (requires a token)',
        params: {
          type: 'object',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title'],
        },
        handler: (p: Record<string, unknown>) => guard(() => createIssueAction(String(p.title), String(p.body || ''))),
      },
      commentIssue: {
        description: 'Add a comment to an issue (requires a token)',
        params: {
          type: 'object',
          properties: { number: { type: 'number' }, body: { type: 'string' } },
          required: ['number', 'body'],
        },
        handler: (p: Record<string, unknown>) => guard(async () => {
          await commentIssueAction(Number(p.number), String(p.body));
          return { ok: true };
        }),
      },
      closeIssue: {
        description: 'Close an issue (requires a token)',
        params: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] },
        handler: (p: Record<string, unknown>) => guard(async () => {
          await setIssueStateAction(Number(p.number), 'closed');
          return { ok: true };
        }),
      },
      reopenIssue: {
        description: 'Reopen a closed issue (requires a token)',
        params: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] },
        handler: (p: Record<string, unknown>) => guard(async () => {
          await setIssueStateAction(Number(p.number), 'open');
          return { ok: true };
        }),
      },
      setToken: {
        description: 'Save (or clear) the GitHub Personal Access Token in storage',
        params: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
        handler: (p: Record<string, unknown>) => guard(async () => {
          await setTokenAction(String(p.token || ''));
          return { hasToken: hasToken() };
        }),
      },
    },
  });
}
