import { registerTool } from './registry.js';

// ── Built-in tools (no Google required) ─────────────────────────────────

registerTool({
  name: 'now',
  description: 'Get the current date and time (UTC and local). Useful when planning or when asked about "today"/"tomorrow".',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const now = new Date();
    return {
      utc: now.toISOString(),
      local: now.toString(),
      weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  },
});

registerTool({
  name: 'memory_set',
  description: 'Persistently remember a fact or preference for this agent (across runs). Use for user preferences, learned context, or state you must keep between sessions.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short snake_case key, e.g. "preferred_working_hours"' },
      value: { type: 'string', description: 'Value to store' },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const key = String(args.key ?? '');
    const value = String(args.value ?? '');
    if (!key) throw new Error('key is required');
    ctx.memory.set(key, value);
    return { stored: true, key };
  },
});

registerTool({
  name: 'memory_get',
  description: 'Read a remembered fact for this agent by key. Use before assuming anything you were told earlier.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Key to read' } },
    required: ['key'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const key = String(args.key ?? '');
    const value = ctx.memory.get(key);
    return { key, value: value ?? null };
  },
});
