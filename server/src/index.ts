import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, ensureDataDir } from './config.js';
import { store } from './store.js';
import { createApp } from './api/app.js';
import { mailSender } from './mail/sender.js';
import { scheduler } from './schedules/scheduler.js';
// Side-effect: registers all tools (built-in, Google, delegate).
import './tools/index.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  ensureDataDir();

  const app = createApp();

  // Serve the built web app from this process in production (single-origin).
  const webDist = path.resolve(serverDir, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`[agent-os] serving web UI from ${webDist}`);
  } else {
    console.log('[agent-os] web/dist not found — API only (run `pnpm --filter @agent-os/web dev` for the UI).');
  }

  const server = app.listen(config.port, () => {
    console.log(`[agent-os] server listening on http://localhost:${config.port}`);
    console.log(`[agent-os] LLM: ${config.llmMock ? 'mock mode (no API key)' : `${config.llmModel} @ ${config.llmBaseUrl}`}`);
    const tokens = store.listGoogleTokens();
    const connected = Object.entries(tokens)
      .filter(([, t]) => t)
      .map(([group, t]) => `${group} (${t?.email})`)
      .join(', ');
    console.log(`[agent-os] Google: ${connected || 'not connected'}`);
    const mail = mailSender.status();
    console.log(
      `[agent-os] mail: ${mail.configured
        ? `${mail.host}:${mail.port} (${mail.security}) as ${mail.fromEmail}`
        : mail.enabled
          ? 'switched on but incomplete — finish it in Settings'
          : 'not configured (Settings → Email notifications)'}`,
    );
  });

  // Cron-style recurring runs. The engine lives in this process and works off
  // the same JSON store; it arms every enabled schedule and ticks from here on.
  scheduler.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[agent-os] ${signal} received, shutting down…`);
    // Stop firing (and abort in-flight scheduled runs) before the store is
    // flushed, so nothing writes after the final save.
    scheduler.stop();
    server.close(async () => {
      await store.flush();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[agent-os] fatal:', err);
  process.exit(1);
});
