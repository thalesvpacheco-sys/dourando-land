import { createApp } from './app.js';
import { config } from './config.js';
import { db, migrationConfig } from './db/knex.js';
import { startWorker } from './worker.js';

await db.migrate.latest(migrationConfig);
createApp().listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: `Dourado Land Intelligence API em http://localhost:${config.port}` }));
});
if (process.env.EMBEDDED_WORKER !== 'false') startWorker();
