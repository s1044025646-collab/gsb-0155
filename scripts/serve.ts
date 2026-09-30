import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, listenLocal } from '../src/server.js';

const dbPath = resolve('data', 'assembly.db');
const app = createApp(dbPath);
const { port } = await listenLocal(app.server, Number(process.env.PORT ?? 0));

mkdirSync(resolve('tmp'), { recursive: true });
writeFileSync(resolve('tmp', 'server.port'), String(port));
writeFileSync(resolve('tmp', 'server.pid'), String(process.pid));
console.log(`DNA assembly API listening on http://127.0.0.1:${port}`);
console.log(`PID ${process.pid}; port recorded in tmp/server.port`);

const shutdown = () => {
  app.server.close(() => {
    app.db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
