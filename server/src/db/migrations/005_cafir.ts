import type { Knex } from 'knex';

/**
 * CAFIR (Receita Federal): cadastro fiscal de imóveis rurais, publicado em dados abertos.
 * Cada imóvel tem o NIRF (número na Receita) e, quando vinculado, o código do imóvel no INCRA (SNCR).
 * É esse código que liga o CAFIR às parcelas do SIGEF: com ele a ficha do mapa mostra o NIRF e a certidão do ITR.
 * Carga: scripts/atualizar-cafir.sh (substitui o conteúdo inteiro a cada edição mensal da Receita).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cafir_imoveis', (t) => {
    t.string('nirf', 8).primary();
    t.string('sncr', 13);
    t.double('area_ha');
    t.text('nome');
    t.string('situacao', 2);
    t.text('municipio');
    t.string('uf', 2);
    t.string('data_inscricao', 10);
    t.string('edicao', 10).notNullable();
  });
  await knex.raw('CREATE INDEX cafir_imoveis_sncr_ix ON cafir_imoveis (sncr) WHERE sncr IS NOT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cafir_imoveis');
}
