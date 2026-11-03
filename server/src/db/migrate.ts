import { db, migrationConfig } from './knex.js';

const [, , cmd] = process.argv;
if (cmd === 'rollback') {
  await db.migrate.rollback(migrationConfig, true);
  console.log('Migrations revertidas.');
} else {
  const [, log] = await db.migrate.latest(migrationConfig);
  console.log(log.length ? `Aplicadas: ${log.join(', ')}` : 'Banco já está atualizado.');
}
await db.destroy();
