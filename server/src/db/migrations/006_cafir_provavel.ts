import type { Knex } from 'knex';

/**
 * NIRF provável: imóveis do SIGEF cujo código INCRA não tem NIRF vinculado no CAFIR, mas que têm exatamente um imóvel
 * no CAFIR com o mesmo município, o mesmo nome e área parecida (±20%). Candidatos ambíguos ficam de fora.
 * Recalculada por scripts/cafir-provavel.sql ao fim de atualizar-cafir.sh e atualizar-bases.sh (os ids do SIGEF mudam a cada carga).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS unaccent');
  await knex.schema.createTable('cafir_provavel', (t) => {
    t.bigInteger('feature_id').primary();
    t.string('nirf', 8).notNullable();
    t.text('nome');
    t.double('area_ha');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cafir_provavel');
}
