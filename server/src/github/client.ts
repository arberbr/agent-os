import { config } from '../config.js';

/**
 * GitHub REST API client (personal access token, no OAuth).
 * https://docs.github.com/en/rest — one token, one user, stored in .env.
 */

export interface GithubClient {
  token: string;
}

export function isGithubConfigured(): boolean {
  return Boolean(config.githubToken);
}

export function githubStatus() {
  return {
    configured: isGithubConfigured(),
    tokenHint: config.githubToken ? `${config.githubToken.slice(0, 4)}…` : null,
  };
}

export function makeGithubClient(): GithubClient | null {
  return config.githubToken ? { token: config.githubToken } : null;
}

const API_ROOT = 'https://api.github.com';

/** "owner/repo" → percent-encoded segments with a literal slash (GitHub 404s on %2F). */
function encodeRepo(repo: string): string {
  return repo.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** Human-friendly GitHub API error messages. */
export function githubErrorMessage(err: unknown): string {
  const e = err as {
    status?: number;
    body?: { message?: string };
    remaining?: string | null;
  };
  const raw = e?.body?.message?.trim() || String(err);
  const status = e?.status ?? 0;

  if (status === 401) {
    return `GitHub authentication failed (${raw}). The GITHUB_TOKEN in .env is invalid, expired or revoked — create a new one at github.com/settings/tokens and restart.`;
  }
  if (status === 403) {
    if (e?.remaining === '0') {
      return 'GitHub API rate limit exceeded for this token. Wait for the limit to reset (see https://api.github.com/rate_limit) or narrow the request.';
    }
    return `GitHub refused the request (403): ${raw} — the token likely lacks permission for this repository or action.`;
  }
  if (status === 404) {
    return `Not found on GitHub (${raw}). Check the owner/repo name and that the token can see the repository.`;
  }
  if (status === 422) {
    return `GitHub rejected the request (422): ${raw}`;
  }
  if (status === 409) {
    return `GitHub conflict (409): ${raw}`;
  }
  return raw || 'Unknown GitHub error.';
}

interface GhInit {
  method?: string;
  body?: unknown;
}

/** Fetch from the GitHub API and parse JSON (throws friendly errors). */
export async function ghRequest(
  client: GithubClient,
  path: string,
  init: GhInit = {},
): Promise<{ status: number; headers: Headers; data: unknown }> {
  const res = await fetch(`${API_ROOT}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agents-os',
      Authorization: `Bearer ${client.token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      githubErrorMessage({
        status: res.status,
        body: typeof data === 'object' && data !== null ? (data as { message?: string }) : undefined,
        remaining,
      }),
    );
  }
  return { status: res.status, headers: res.headers, data };
}

// ── Identity (used by status/test endpoints) ────────────────────────────

export interface GithubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
  scopes: string[];
  rateLimitRemaining: string | null;
}

/** GET /user — identity plus token scopes from response headers. */
export async function githubGetUser(client: GithubClient): Promise<GithubUser> {
  const { headers, data } = await ghRequest(client, '/user');
  const user = data as {
    login?: string;
    name?: string | null;
    avatar_url?: string;
  };
  const scopes = (headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    login: user.login ?? 'unknown',
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? '',
    scopes,
    rateLimitRemaining: headers.get('x-ratelimit-remaining'),
  };
}

// ── Repositories ────────────────────────────────────────────────────────

export interface RepoInfo {
  id: number;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  htmlUrl: string;
  defaultBranch: string;
  language: string | null;
  stars: number;
  openIssues: number;
  updatedAt: string | null;
  pushedAt: string | null;
}

type RepoJson = {
  id?: number;
  full_name?: string;
  owner?: { login?: string };
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  html_url?: string;
  default_branch?: string;
  language?: string | null;
  stargazers_count?: number;
  open_issues_count?: number;
  updated_at?: string | null;
  pushed_at?: string | null;
};

function toRepoInfo(r: RepoJson): RepoInfo {
  return {
    id: r.id ?? 0,
    fullName: r.full_name ?? '',
    owner: r.owner?.login ?? '',
    description: r.description ?? null,
    private: r.private ?? false,
    fork: r.fork ?? false,
    htmlUrl: r.html_url ?? '',
    defaultBranch: r.default_branch ?? '',
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    updatedAt: r.updated_at ?? null,
    pushedAt: r.pushed_at ?? null,
  };
}

/** Repos the token can see: owned, collaborator and org-member repos. */
export async function githubListRepos(
  client: GithubClient,
  args: { sort?: 'created' | 'updated' | 'pushed' | 'full_name'; perPage?: number },
): Promise<RepoInfo[]> {
  const sort = args.sort ?? 'updated';
  const perPage = Math.min(args.perPage ?? 20, 100);
  const { data } = await ghRequest(
    client,
    `/user/repos?sort=${encodeURIComponent(sort)}&per_page=${perPage}&affiliation=owner,collaborator,organization_member`,
  );
  return (data as RepoJson[]).map(toRepoInfo);
}

/** Search public repos on all of GitHub (also reachable without a token). */
export async function githubSearchRepos(
  client: GithubClient,
  args: { query: string; perPage?: number },
): Promise<{ total: number; repos: RepoInfo[] }> {
  const perPage = Math.min(args.perPage ?? 10, 30);
  const { data } = await ghRequest(
    client,
    `/search/repositories?q=${encodeURIComponent(args.query)}&per_page=${perPage}`,
  );
  const res = data as { total_count?: number; items?: RepoJson[] };
  return { total: res.total_count ?? 0, repos: (res.items ?? []).map(toRepoInfo) };
}

export async function githubGetRepo(client: GithubClient, repo: string): Promise<RepoInfo> {
  const { data } = await ghRequest(client, `/repos/${encodeRepo(repo)}`);
  return toRepoInfo(data as RepoJson);
}

// ── Issues ──────────────────────────────────────────────────────────────

export interface IssueInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  htmlUrl: string;
  user: string;
  labels: string[];
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  body: string | null;
}

type IssueJson = {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }>;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  body?: string | null;
};

function toIssueInfo(i: IssueJson): IssueInfo {
  return {
    number: i.number ?? 0,
    title: i.title ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    htmlUrl: i.html_url ?? '',
    user: i.user?.login ?? '',
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    assignees: (i.assignees ?? []).map((a) => a.login ?? ''),
    comments: i.comments ?? 0,
    createdAt: i.created_at ?? '',
    updatedAt: i.updated_at ?? '',
    body: i.body ?? null,
  };
}

/** List repo issues (note: this endpoint also returns pull requests). */
export async function githubListIssues(
  client: GithubClient,
  args: { repo: string; state?: 'open' | 'closed' | 'all'; labels?: string; assignee?: string; perPage?: number },
): Promise<IssueInfo[]> {
  const params = new URLSearchParams();
  params.set('state', args.state ?? 'open');
  params.set('per_page', String(Math.min(args.perPage ?? 20, 100)));
  if (args.labels) params.set('labels', args.labels);
  if (args.assignee) params.set('assignee', args.assignee);
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/issues?${params}`);
  return (data as IssueJson[]).map(toIssueInfo);
}

export async function githubGetIssue(
  client: GithubClient,
  args: { repo: string; issueNumber: number },
): Promise<IssueInfo> {
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/issues/${args.issueNumber}`);
  return toIssueInfo(data as IssueJson);
}

export async function githubCreateIssue(
  client: GithubClient,
  args: { repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] },
): Promise<IssueInfo> {
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/issues`, {
    method: 'POST',
    body: {
      title: args.title,
      body: args.body,
      labels: args.labels,
      assignees: args.assignees,
    },
  });
  return toIssueInfo(data as IssueJson);
}

export async function githubCommentIssue(
  client: GithubClient,
  args: { repo: string; issueNumber: number; body: string },
): Promise<{ id: number; htmlUrl: string }> {
  const { data } = await ghRequest(
    client,
    `/repos/${encodeRepo(args.repo)}/issues/${args.issueNumber}/comments`,
    { method: 'POST', body: { body: args.body } },
  );
  const comment = data as { id?: number; html_url?: string };
  return { id: comment.id ?? 0, htmlUrl: comment.html_url ?? '' };
}

// ── Pull requests ───────────────────────────────────────────────────────

export interface PullInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  user: string;
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  body: string | null;
}

type PullJson = {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  user?: { login?: string };
  head?: { ref?: string };
  base?: { ref?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
  updated_at?: string;
  body?: string | null;
};

function toPullInfo(p: PullJson): PullInfo {
  return {
    number: p.number ?? 0,
    title: p.title ?? '',
    state: p.state === 'closed' ? 'closed' : 'open',
    draft: p.draft ?? false,
    merged: p.merged ?? false,
    htmlUrl: p.html_url ?? '',
    user: p.user?.login ?? '',
    headRef: p.head?.ref ?? '',
    baseRef: p.base?.ref ?? '',
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    createdAt: p.created_at ?? '',
    updatedAt: p.updated_at ?? '',
    body: p.body ?? null,
  };
}

export async function githubListPulls(
  client: GithubClient,
  args: { repo: string; state?: 'open' | 'closed' | 'all'; perPage?: number },
): Promise<PullInfo[]> {
  const params = new URLSearchParams();
  params.set('state', args.state ?? 'open');
  params.set('per_page', String(Math.min(args.perPage ?? 20, 100)));
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/pulls?${params}`);
  return (data as PullJson[]).map(toPullInfo);
}

export async function githubGetPull(
  client: GithubClient,
  args: { repo: string; pullNumber: number },
): Promise<PullInfo> {
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/pulls/${args.pullNumber}`);
  return toPullInfo(data as PullJson);
}

export async function githubCreatePull(
  client: GithubClient,
  args: { repo: string; title: string; head: string; base: string; body?: string; draft?: boolean },
): Promise<PullInfo> {
  const { data } = await ghRequest(client, `/repos/${encodeRepo(args.repo)}/pulls`, {
    method: 'POST',
    body: { title: args.title, head: args.head, base: args.base, body: args.body, draft: args.draft ?? false },
  });
  return toPullInfo(data as PullJson);
}

// ── Repository contents ─────────────────────────────────────────────────

export interface FileInfo {
  path: string;
  sha: string;
  size: number;
  /** UTF-8 text content when the file is text. */
  text?: string;
  /** Base64 content when the file is binary (or too large to inline). */
  contentBase64?: string;
  binary: boolean;
}

/** Read a file (or list a directory). Returns entries when `path` is a directory. */
export async function githubGetFile(
  client: GithubClient,
  args: { repo: string; path: string; ref?: string },
): Promise<FileInfo | Array<{ name: string; path: string; type: 'file' | 'dir'; size: number }>> {
  const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
  const { data } = await ghRequest(
    client,
    `/repos/${encodeRepo(args.repo)}/contents/${args.path.split('/').map(encodeURIComponent).join('/')}${ref}`,
  );

  if (Array.isArray(data)) {
    return (data as Array<{ name?: string; path?: string; type?: string; size?: number }>).map((e) => ({
      name: e.name ?? '',
      path: e.path ?? '',
      type: e.type === 'dir' ? 'dir' : 'file',
      size: e.size ?? 0,
    }));
  }

  const file = data as { name?: string; path?: string; sha?: string; size?: number; content?: string; encoding?: string };
  const size = file.size ?? 0;
  const content = typeof file.content === 'string' ? file.content : '';
  let text: string | undefined;
  let contentBase64: string | undefined;
  let binary = false;

  if (content) {
    const buf = Buffer.from(content.replace(/\n/g, ''), 'base64');
    if (size <= 512_000 && !buf.includes(0)) {
      text = buf.toString('utf8');
    } else {
      contentBase64 = buf.toString('base64');
      binary = true;
    }
  }

  return { path: file.path ?? args.path, sha: file.sha ?? '', size, text, contentBase64, binary };
}

/**
 * Create or update a file. When `sha` is omitted, the current file is fetched
 * first (so updates always succeed); otherwise a brand-new file is created.
 */
export async function githubWriteFile(
  client: GithubClient,
  args: { repo: string; path: string; content: string; message?: string; branch?: string; sha?: string },
): Promise<{ path: string; sha: string; created: boolean; commitUrl: string }> {
  let sha = args.sha;
  let created = false;

  if (!sha) {
    try {
      const existing = await githubGetFile(client, { repo: args.repo, path: args.path, ref: args.branch });
      if (!Array.isArray(existing)) {
        sha = existing.sha;
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('Not found on GitHub'))) throw err;
      created = true;
    }
  }

  const { data } = await ghRequest(
    client,
    `/repos/${encodeRepo(args.repo)}/contents/${args.path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      body: {
        message: args.message ?? `${created ? 'Create' : 'Update'} ${args.path} via Agents OS`,
        content: Buffer.from(args.content, 'utf8').toString('base64'),
        branch: args.branch,
        sha,
      },
    },
  );
  const res = data as { content?: { path?: string; sha?: string; html_url?: string }; commit?: { html_url?: string } };
  return {
    path: res.content?.path ?? args.path,
    sha: res.content?.sha ?? '',
    created,
    commitUrl: res.commit?.html_url ?? '',
  };
}
