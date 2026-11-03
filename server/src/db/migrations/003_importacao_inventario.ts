import type { Knex } from 'knex';

/**
 * Controle da importação/sincronização do inventário externo (pastas do Drive).
 * import_items: uma linha por pasta de área, com hash do conteúdo e o retrato dos valores importados —
 *   permite reimportar sem duplicar e sem sobrescrever o que a equipe editou na plataforma.
 * import_files: um registro por arquivo (sha256) já trazido, e para onde foi (documento, mídia, pendente de conversão).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('source').notNullable(); // ex.: drive:grandes-negocios
    t.string('origin_label');
    t.string('mode').notNullable(); // preview | apply
    t.jsonb('summary').notNullable().defaultTo('{}');
    t.uuid('created_by').references('users.id');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });
  });
  await knex.schema.createTable('import_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('source').notNullable();
    t.text('external_key').notNullable(); // caminho da pasta
    t.string('entity_type').notNullable(); // opportunity | prospect
    t.uuid('entity_id').notNullable();
    t.string('content_hash', 64).notNullable();
    t.string('sheet_hash', 64);
    t.jsonb('imported').notNullable().defaultTo('{}'); // valores gravados pela importação (para detectar edição manual)
    t.jsonb('issues').notNullable().defaultTo('[]');
    t.string('status').notNullable().defaultTo('active'); // active | missing (pasta sumiu da origem)
    t.uuid('last_run_id').references('import_runs.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['org_id', 'source', 'external_key']);
  });
  await knex.schema.createTable('import_files', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('item_id').notNullable().references('import_items.id').onDelete('CASCADE');
    t.text('path').notNullable();
    t.string('sha256', 64).notNullable();
    t.bigInteger('size').notNullable();
    t.string('target').notNullable(); // document | media | geometry | pending (prospecção: anexa na conversão) | skipped
    t.uuid('target_id');
    t.string('category');
    t.string('storage_key');
    t.string('mime');
    t.string('note');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['item_id', 'path', 'sha256']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_files');
  await knex.schema.dropTableIfExists('import_items');
  await knex.schema.dropTableIfExists('import_runs');
}
