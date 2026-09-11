import { registerTool, type ToolContext } from './registry.js';
import {
  githubCommentIssue, githubCreateIssue, githubCreatePull, githubGetFile, githubGetIssue,
  githubGetPull, githubGetRepo, githubListIssues, githubListPulls, githubListRepos,
  githubSearchRepos, githubWriteFile,
} from '../github/client.js';

async function requireGithub(ctx: ToolContext) {
  if (ctx.github) return ctx.github;
  throw new Error('GitHub is not connected. Set GITHUB_TOKEN in .env (create one at github.com/settings/tokens), restart the server, then check the Integrations page.');
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

// ── Repositories ────────────────────────────────────────────────────────

registerTool({
  name: 'github_list_repos',
  description: 'List GitHub repositories the token can access (owned, collaborator and org-member repos).',
  parameters: {
    type: 'object',
    properties: {
      sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Default updated' },
      perPage: { type: 'number', description: 'Default 20, max 100' },
    },
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    const sort = str(args.sort, 'updated');
    return githubListRepos(client, {
      sort: sort === 'created' || sort === 'pushed' || sort === 'full_name' ? sort : 'updated',
      perPage: num(args.perPage, 20),
    });
  },
});

registerTool({
  name: 'github_search_repos',
  description: 'Search repositories on all of GitHub, e.g. "react state management stars:>1000". Returns the best matches with stars, language and description.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'GitHub repository search query' },
      perPage: { type: 'number', description: 'Default 10, max 30' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubSearchRepos(client, { query: str(args.query), perPage: num(args.perPage, 10) });
  },
});

registerTool({
  name: 'github_get_repo',
  description: 'Get details for one repository: "owner/repo" (e.g. "vercel/next.js").',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubGetRepo(client, str(args.repo));
  },
});

// ── Issues ──────────────────────────────────────────────────────────────

registerTool({
  name: 'github_list_issues',
  description: 'List issues in a repository (this endpoint also returns pull requests). Filter by state, label or assignee.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' },
      labels: { type: 'string', description: 'Comma-separated label names' },
      assignee: { type: 'string', description: 'Assignee username' },
      perPage: { type: 'number', description: 'Default 20, max 100' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    const state = str(args.state, 'open');
    return githubListIssues(client, {
      repo: str(args.repo),
      state: state === 'closed' || state === 'all' ? state : 'open',
      labels: str(args.labels) || undefined,
      assignee: str(args.assignee) || undefined,
      perPage: num(args.perPage, 20),
    });
  },
});

registerTool({
  name: 'github_get_issue',
  description: 'Get one issue with its full body text.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      issueNumber: { type: 'number', description: 'Issue number' },
    },
    required: ['repo', 'issueNumber'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubGetIssue(client, { repo: str(args.repo), issueNumber: num(args.issueNumber, 0) });
  },
});

registerTool({
  name: 'github_create_issue',
  description: 'Open a new issue in a repository. Confirm the title and repository with the user before creating.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'array', items: { type: 'string' } },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Usernames' },
    },
    required: ['repo', 'title'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubCreateIssue(client, {
      repo: str(args.repo),
      title: str(args.title),
      body: str(args.body) || undefined,
      labels: strArr(args.labels),
      assignees: strArr(args.assignees),
    });
  },
});

registerTool({
  name: 'github_comment_issue',
  description: 'Add a comment to an issue or pull request.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      issueNumber: { type: 'number', description: 'Issue or PR number' },
      body: { type: 'string', description: 'Comment body (Markdown)' },
    },
    required: ['repo', 'issueNumber', 'body'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubCommentIssue(client, { repo: str(args.repo), issueNumber: num(args.issueNumber, 0), body: str(args.body) });
  },
});

// ── Pull requests ───────────────────────────────────────────────────────

registerTool({
  name: 'github_list_pull_requests',
  description: 'List pull requests in a repository with head/base branches, merge state and diff size.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' },
      perPage: { type: 'number', description: 'Default 20, max 100' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    const state = str(args.state, 'open');
    return githubListPulls(client, {
      repo: str(args.repo),
      state: state === 'closed' || state === 'all' ? state : 'open',
      perPage: num(args.perPage, 20),
    });
  },
});

registerTool({
  name: 'github_get_pull_request',
  description: 'Get one pull request with its full body text.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      pullNumber: { type: 'number' },
    },
    required: ['repo', 'pullNumber'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubGetPull(client, { repo: str(args.repo), pullNumber: num(args.pullNumber, 0) });
  },
});

registerTool({
  name: 'github_create_pull_request',
  description: 'Open a pull request. The head branch must exist on the repository (or be "username:branch" for a fork). Confirm the title and base branch with the user before creating.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      title: { type: 'string' },
      head: { type: 'string', description: 'Branch containing the changes' },
      base: { type: 'string', description: 'Branch to merge into, e.g. main' },
      body: { type: 'string', description: 'PR description (Markdown)' },
      draft: { type: 'boolean', description: 'Create as draft' },
    },
    required: ['repo', 'title', 'head', 'base'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubCreatePull(client, {
      repo: str(args.repo),
      title: str(args.title),
      head: str(args.head),
      base: str(args.base),
      body: str(args.body) || undefined,
      draft: args.draft === true,
    });
  },
});

// ── Repository contents ─────────────────────────────────────────────────

registerTool({
  name: 'github_get_file',
  description: 'Read a file from a repository (UTF-8 text returned directly; binary files returned as base64). Passing a directory path lists its entries.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      path: { type: 'string', description: 'File path in the repo, e.g. "src/app.ts" or "docs"' },
      ref: { type: 'string', description: 'Branch, tag or commit sha (default: default branch)' },
    },
    required: ['repo', 'path'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubGetFile(client, { repo: str(args.repo), path: str(args.path), ref: str(args.ref) || undefined });
  },
});

registerTool({
  name: 'github_write_file',
  description: 'Create or update a single file in a repository (commits directly to the given branch). Always confirm the repository, path and content with the user before writing.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Full name as owner/repo' },
      path: { type: 'string', description: 'File path in the repo, e.g. "src/notes.md"' },
      content: { type: 'string', description: 'New file content' },
      branch: { type: 'string', description: 'Branch to commit to (default: default branch)' },
      message: { type: 'string', description: 'Commit message' },
    },
    required: ['repo', 'path', 'content'],
    additionalProperties: false,
  },
  requiresGithub: true,
  async execute(args, ctx) {
    const client = await requireGithub(ctx);
    return githubWriteFile(client, {
      repo: str(args.repo),
      path: str(args.path),
      content: str(args.content),
      branch: str(args.branch) || undefined,
      message: str(args.message) || undefined,
    });
  },
});
