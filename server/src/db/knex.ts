import { fileURLToPath } from 'node:url';
import knexFactory, { type Knex } from 'knex';
import pg from 'pg';
import { config } from '../config.js';

// numeric/decimal como number (valores monetários cabem com folga em double para exibição; cálculos críticos ficam no banco)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date como string ISO (sem fuso)
pg.types.setTypeParser(1082, (v) => v);

export const db: Knex = knexFactory({
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
});

export const migrationConfig = {
  directory: fileURLToPath(new URL('./migrations', import.meta.url)),
  loadExtensions: ['.ts'],
  tableName: 'knex_migrations',
};
