import type { Knex } from 'knex';

/**
 * Login próprio (senha, convite, 2 etapas, bloqueio, revogação de sessão) e
 * bases territoriais oficiais carregadas no PostGIS (SIGEF, SNCI, CAR, restrições).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.text('password_hash');
    t.timestamp('password_changed_at', { useTz: true });
    t.text('mfa_secret_enc');
    t.jsonb('mfa_recovery_hashes').notNullable().defaultTo('[]');
    t.bigInteger('mfa_last_step').notNullable().defaultTo(0);
    t.integer('failed_logins').notNullable().defaultTo(0);
    t.timestamp('locked_until', { useTz: true });
    t.timestamp('last_login_at', { useTz: true });
    t.integer('session_version').notNullable().defaultTo(1);
  });
  // e-mail é o identificador de login: único em toda a plataforma, sem diferenciar maiúsculas
  await knex.raw('CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email))');

  await knex.schema.createTable('auth_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('kind').notNullable(); // invite | reset
    t.string('token_hash').notNullable().unique(); // só o hash fica no banco
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.uuid('created_by').references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'kind']);
  });

  await knex.schema.createTable('territory_features', (t) => {
    t.bigIncrements('id');
    t.string('layer').notNullable();
    t.string('uf', 2);
    t.text('code');
    t.text('name');
    t.double('area_ha');
    t.text('municipio');
    t.text('situacao');
    t.text('matricula');
    t.text('cns_serventia');
    t.text('data_referencia');
    t.jsonb('raw').notNullable().defaultTo('{}');
    t.specificType('geom', 'geometry(MultiPolygon, 4326)').notNullable();
    t.index(['layer', 'uf']);
    t.index(['layer', 'area_ha']);
  });
  await knex.raw('CREATE INDEX territory_features_geom_gix ON territory_features USING GIST (geom)');
  await knex.raw('CREATE INDEX territory_features_code_ix ON territory_features (lower(code))');
  await knex.raw('CREATE INDEX territory_features_matricula_ix ON territory_features (matricula)');
  await knex.raw('CREATE INDEX territory_features_municipio_ix ON territory_features (uf, lower(municipio))');

  // o que foi carregado, de onde e quando: toda consulta mostra fonte e data
  await knex.schema.createTable('territory_datasets', (t) => {
    t.string('layer').notNullable();
    t.string('uf', 2).notNullable();
    t.text('source_name').notNullable();
    t.integer('features').notNullable();
    t.timestamp('loaded_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['layer', 'uf']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('territory_datasets');
  await knex.schema.dropTableIfExists('territory_features');
  await knex.schema.dropTableIfExists('auth_tokens');
  await knex.raw('DROP INDEX IF EXISTS users_email_lower_uq');
  await knex.schema.alterTable('users', (t) => {
    for (const c of ['password_hash', 'password_changed_at', 'mfa_secret_enc', 'mfa_recovery_hashes', 'mfa_last_step', 'failed_logins', 'locked_until', 'last_login_at', 'session_version']) t.dropColumn(c);
  });
}
