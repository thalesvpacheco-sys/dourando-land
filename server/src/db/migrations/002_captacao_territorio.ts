import type { Knex } from 'knex';

/** Captação de novas áreas + cache de dados territoriais (SIGEF/INCRA, SICAR/CAR, consulta registral ONR). */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('land_prospects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('code').notNullable().unique(); // CAP-2026-0001
    t.string('title').notNullable();
    t.string('source').notNullable(); // mapa_territorial | site_proprietario | indicacao_parceiro | prospeccao_ativa | outro
    t.string('stage').notNullable().defaultTo('identificada');
    t.string('status').notNullable().defaultTo('open'); // open | converted | discarded
    t.string('discard_reason');
    t.string('priority').notNullable().defaultTo('media');
    t.string('land_type');
    t.string('uf', 2);
    t.string('city');
    t.string('region');
    t.double('lat');
    t.double('lng');
    t.specificType('geom', 'geometry(MultiPolygon,4326)');
    t.double('area_m2');
    t.specificType('intended_uses', 'text[]').notNullable().defaultTo('{}');
    t.decimal('asking_price_hint', 16, 2);
    // contato do proprietário: privado, nunca vai para o portal
    t.string('owner_name');
    t.string('owner_phone', 20);
    t.string('owner_email');
    t.text('owner_notes');
    t.string('legal_basis'); // consentimento (formulário) | legitimo_interesse (prospecção ativa)
    // identificação registral/cadastral
    t.string('matricula');
    t.string('cartorio');
    t.string('cns_serventia');
    t.string('sigef_code');
    t.string('car_code');
    t.string('ccir');
    t.jsonb('territory_snapshot').notNullable().defaultTo('[]'); // [{layer, source, consulted_at, properties}]
    t.jsonb('checklist').notNullable().defaultTo('[]'); // [{category, status, note, updated_at}]
    t.uuid('assigned_to').references('users.id');
    t.uuid('referred_by_broker_id').references('land_brokers.id');
    t.string('next_action');
    t.timestamp('next_action_at', { useTz: true });
    t.uuid('opportunity_id').references('land_opportunities.id');
    t.integer('version').notNullable().defaultTo(1);
    t.uuid('created_by').references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['org_id', 'stage']);
  });
  await knex.raw('CREATE INDEX land_prospects_geom_gix ON land_prospects USING GIST (geom)');

  await knex.schema.alterTable('activities', (t) => {
    t.uuid('prospect_id').references('land_prospects.id').onDelete('CASCADE');
  });

  await knex.schema.createTable('territory_cache', (t) => {
    t.string('key').primary(); // camada + bbox arredondado
    t.string('layer').notNullable();
    t.jsonb('data').notNullable();
    t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('territory_cache');
  await knex.schema.alterTable('activities', (t) => t.dropColumn('prospect_id'));
  await knex.schema.dropTableIfExists('land_prospects');
}
