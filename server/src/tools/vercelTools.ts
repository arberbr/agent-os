import { registerTool, type ToolContext } from './registry.js';
import {
  vercelCancelDeployment, vercelGetDeployment, vercelGetProject, vercelListDeployments,
  vercelListDomains, vercelListProjectEnv, vercelListProjects, vercelRedeploy,
} from '../vercel/client.js';

async function requireVercel(ctx: ToolContext) {
  if (ctx.vercel) return ctx.vercel;
  throw new Error('Vercel is not connected. Set VERCEL_TOKEN in .env (create one at vercel.com/account/tokens), restart the server, then check the Integrations page.');
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ── Projects ────────────────────────────────────────────────────────────

registerTool({
  name: 'vercel_list_projects',
  description: 'List Vercel projects visible to the token (name, framework, git source, last update).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Default 20, max 100' },
    },
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelListProjects(client, { limit: num(args.limit, 20) });
  },
});

registerTool({
  name: 'vercel_get_project',
  description: 'Get one Vercel project by id or name, including its env var keys and production alias.',
  parameters: {
    type: 'object',
    properties: {
      projectIdOrName: { type: 'string', description: 'Project id or name' },
    },
    required: ['projectIdOrName'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelGetProject(client, str(args.projectIdOrName));
  },
});

// ── Deployments ─────────────────────────────────────────────────────────

registerTool({
  name: 'vercel_list_deployments',
  description: 'List deployments of a Vercel project (state, target, url and aliases).',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project id (from vercel_list_projects)' },
      limit: { type: 'number', description: 'Default 10, max 100' },
      state: { type: 'string', enum: ['BUILDING', 'ERROR', 'INITIALIZING', 'QUEUED', 'READY', 'CANCELED'], description: 'Filter by state' },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelListDeployments(client, {
      projectId: str(args.projectId),
      limit: num(args.limit, 10),
      state: str(args.state) || undefined,
    });
  },
});

registerTool({
  name: 'vercel_get_deployment',
  description: 'Get one Vercel deployment by id.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: { type: 'string' },
    },
    required: ['deploymentId'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelGetDeployment(client, str(args.deploymentId));
  },
});

registerTool({
  name: 'vercel_redeploy',
  description: 'Redeploy an existing Vercel deployment from the same source (git commit or previous build). The new deployment inherits the original target (production/preview). Confirm with the user before triggering production redeploys.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: { type: 'string', description: 'Deployment id to redeploy' },
    },
    required: ['deploymentId'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelRedeploy(client, { deploymentId: str(args.deploymentId) });
  },
});

registerTool({
  name: 'vercel_cancel_deployment',
  description: 'Cancel a running Vercel deployment. Confirm with the user before cancelling.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: { type: 'string' },
    },
    required: ['deploymentId'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelCancelDeployment(client, str(args.deploymentId));
  },
});

// ── Domains & env vars ──────────────────────────────────────────────────

registerTool({
  name: 'vercel_list_domains',
  description: 'List the domains in the Vercel account (name and verification status).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Default 20, max 100' },
    },
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelListDomains(client, { limit: num(args.limit, 20) });
  },
});

registerTool({
  name: 'vercel_list_env_vars',
  description: 'List the environment variables of a Vercel project (keys and targets). Values are hidden unless decrypt is true — only request decrypted values when you actually need them.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project id' },
      decrypt: { type: 'boolean', description: 'Also return secret values (default false)' },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  requiresVercel: true,
  async execute(args, ctx) {
    const client = await requireVercel(ctx);
    return vercelListProjectEnv(client, { projectId: str(args.projectId), decrypt: args.decrypt === true });
  },
});
