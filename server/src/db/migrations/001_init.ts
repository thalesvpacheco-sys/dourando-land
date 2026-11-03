import type { Knex } from 'knex';

/**
 * Esquema inicial do Dourado Land Intelligence.
 * Convenções: UUID, created_at/updated_at, org_id em toda entidade de domínio (isolamento multi-tenant),
 * version para bloqueio otimista onde há edição concorrente.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  const ts = (t: Knex.CreateTableBuilder) => {
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  };
  const id = (t: Knex.CreateTableBuilder) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

  // --------------------------------------------------------------- identidade / organização
  await knex.schema.createTable('organizations', (t) => {
    id(t);
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('kind').notNullable(); // platform | manager | partner
    t.string('code_prefix', 6); // ex.: DOU
    t.string('central_whatsapp', 20);
    t.jsonb('settings').notNullable().defaultTo('{}');
    ts(t);
  });

  await knex.schema.createTable('users', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('external_id').unique(); // sub do JWT da WingsBr
    t.string('name').notNullable();
    t.string('email').notNullable();
    t.string('phone', 20);
    t.string('role').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.boolean('mfa_enabled').notNullable().defaultTo(false);
    ts(t);
    t.unique(['org_id', 'email']);
  });

  await knex.schema.createTable('roles', (t) => {
    t.string('key').primary();
    t.string('name').notNullable();
  });
  await knex.schema.createTable('permissions', (t) => {
    t.increments('id');
    t.string('role_key').notNullable().references('roles.key');
    t.string('resource').notNullable();
    t.specificType('actions', 'text[]').notNullable();
    t.string('scope').notNullable(); // all | org | assigned | own | none
    t.unique(['role_key', 'resource']);
  });

  await knex.schema.createTable('land_brokers', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('user_id').notNullable().unique().references('users.id');
    t.string('creci', 20);
    t.string('creci_uf', 2);
    t.string('creci_status').notNullable().defaultTo('nao_verificado'); // nao_verificado | ativo | irregular | nao_aplicavel
    t.timestamp('creci_checked_at', { useTz: true });
    t.string('whatsapp', 20);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('last_routed_at', { useTz: true });
    ts(t);
  });

  // --------------------------------------------------------------- oportunidades
  await knex.schema.createTable('land_opportunities', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('code').notNullable().unique(); // DOU-GO-0001
    t.string('slug').notNullable().unique();
    t.string('internal_name').notNullable();
    t.string('public_title');
    t.string('type');
    t.string('city');
    t.string('uf', 2);
    t.string('neighborhood');
    t.string('region');
    t.string('address');
    t.double('lat');
    t.double('lng');
    t.double('area_m2');
    t.double('usable_area_m2');
    t.double('frontage_m');
    t.double('depth_m');
    t.string('topography');
    t.string('status').notNullable().defaultTo('captacao');
    t.string('publication_status').notNullable().defaultTo('draft');
    t.string('visibility').notNullable().defaultTo('public'); // public | private (vitrine logada)
    t.text('summary');
    t.text('strategic_description');
    t.boolean('featured').notNullable().defaultTo(false);
    t.uuid('internal_owner_id').references('users.id');
    t.integer('draft_step').notNullable().defaultTo(1);
    t.integer('version').notNullable().defaultTo(1);
    t.timestamp('published_at', { useTz: true });
    t.uuid('created_by').references('users.id');
    ts(t);
    t.index(['org_id', 'publication_status']);
    t.index(['uf', 'city']);
  });

  await knex.schema.createTable('land_geometries', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.specificType('geom', 'geometry(MultiPolygon,4326)').notNullable();
    t.specificType('centroid', 'geometry(Point,4326)').notNullable();
    t.specificType('public_point', 'geometry(Point,4326)');
    t.double('area_m2').notNullable();
    t.double('perimeter_m').notNullable();
    t.string('source').notNullable(); // draw | geojson | kml | kmz | shp
    t.integer('version').notNullable();
    t.boolean('is_current').notNullable().defaultTo(true);
    t.uuid('created_by').references('users.id');
    ts(t);
  });
  await knex.raw('CREATE INDEX land_geometries_geom_gix ON land_geometries USING GIST (geom)');
  await knex.raw('CREATE INDEX land_geometries_public_gix ON land_geometries USING GIST (public_point)');
  await knex.raw('CREATE UNIQUE INDEX land_geometries_current ON land_geometries (opportunity_id) WHERE is_current');

  await knex.schema.createTable('land_technical_attributes', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.string('key').notNullable();
    t.jsonb('value');
    t.string('source');
    t.date('consulted_at');
    t.string('responsible');
    t.string('validation_status').notNullable().defaultTo('nao_verificado');
    ts(t);
    t.unique(['opportunity_id', 'key']);
  });

  await knex.schema.createTable('land_commercial_terms', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().unique().references('land_opportunities.id').onDelete('CASCADE');
    t.specificType('modalities', 'text[]').notNullable().defaultTo('{}');
    t.decimal('asking_price', 16, 2);
    t.decimal('swap_pct', 5, 2);
    t.decimal('down_payment', 16, 2);
    t.text('payment_terms');
    t.integer('expected_units');
    t.decimal('vgv_preliminary', 16, 2);
    t.double('constructive_potential_m2');
    t.decimal('commission_total_pct', 5, 2);
    t.jsonb('commission_split').notNullable().defaultTo('[]');
    t.boolean('exclusivity').notNullable().defaultTo(false);
    t.date('exclusivity_until');
    t.boolean('negotiable').notNullable().defaultTo(true);
    t.text('internal_notes');
    ts(t);
  });

  await knex.schema.createTable('publication_permissions', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().unique().references('land_opportunities.id').onDelete('CASCADE');
    t.boolean('show_price').notNullable().defaultTo(false);
    t.boolean('show_price_per_m2').notNullable().defaultTo(false);
    t.boolean('show_owner').notNullable().defaultTo(false);
    t.string('location_precision').notNullable().defaultTo('approximate'); // exact | approximate | region
    t.boolean('show_public_documents').notNullable().defaultTo(true);
    t.string('legal_basis'); // descrição da base jurídica quando não há documento
    t.uuid('authorization_document_id');
    t.uuid('submitted_by').references('users.id');
    t.timestamp('submitted_at', { useTz: true });
    t.uuid('reviewed_by').references('users.id');
    t.timestamp('reviewed_at', { useTz: true });
    t.text('review_notes');
    ts(t);
  });

  await knex.schema.createTable('land_owners', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('user_id').references('users.id'); // acesso ao portal do proprietário
    t.string('kind').notNullable(); // pf | pj
    t.string('name').notNullable();
    t.text('document_enc'); // CPF/CNPJ criptografado
    t.string('email');
    t.string('phone', 20);
    t.string('representative');
    t.decimal('share_pct', 5, 2);
    ts(t);
  });

  await knex.schema.createTable('land_documents', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('group_id').notNullable(); // agrupa versões
    t.integer('version').notNullable();
    t.boolean('is_current').notNullable().defaultTo(true);
    t.string('category').notNullable();
    t.string('title').notNullable();
    t.string('confidentiality').notNullable().defaultTo('confidential');
    t.string('storage_key').notNullable();
    t.string('mime').notNullable();
    t.string('original_name').notNullable();
    t.integer('size').notNullable();
    t.string('sha256', 64).notNullable();
    t.date('valid_until');
    t.uuid('uploaded_by').references('users.id');
    ts(t);
  });

  await knex.schema.createTable('land_media', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.string('storage_key').notNullable();
    t.string('caption');
    t.integer('sort').notNullable().defaultTo(0);
    t.boolean('is_cover').notNullable().defaultTo(false);
    t.integer('width');
    t.integer('height');
    ts(t);
  });

  await knex.schema.createTable('broker_assignments', (t) => {
    id(t);
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('broker_id').notNullable().references('land_brokers.id');
    t.string('role').notNullable().defaultTo('primary'); // primary | support
    t.boolean('active').notNullable().defaultTo(true);
    t.uuid('assigned_by').references('users.id');
    t.string('reason');
    t.timestamp('ended_at', { useTz: true });
    ts(t);
  });
  await knex.raw(`CREATE UNIQUE INDEX broker_assignments_primary ON broker_assignments (opportunity_id) WHERE active AND role = 'primary'`);

  // --------------------------------------------------------------- compradores e matching
  await knex.schema.createTable('partner_companies', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id'); // organização gestora (Dourado)
    t.uuid('partner_org_id').references('organizations.id'); // organização da própria empresa, se tiver login
    t.string('name').notNullable();
    t.string('kind').notNullable(); // construtora | incorporadora | loteadora | investidor
    t.string('cnpj', 20);
    t.string('contact_name');
    t.string('contact_email');
    t.string('contact_phone', 20);
    ts(t);
  });

  await knex.schema.createTable('acquisition_profiles', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('partner_company_id').notNullable().references('partner_companies.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.specificType('ufs', 'text[]').notNullable().defaultTo('{}');
    t.specificType('cities', 'text[]').notNullable().defaultTo('{}');
    t.double('min_area_m2');
    t.double('max_area_m2');
    t.specificType('typologies', 'text[]').notNullable().defaultTo('{}');
    t.decimal('budget_max', 16, 2);
    t.specificType('modalities', 'text[]').notNullable().defaultTo('{}');
    t.decimal('max_swap_pct', 5, 2);
    t.decimal('vgv_target', 16, 2);
    t.string('min_approval_stage');
    t.jsonb('restrictions').notNullable().defaultTo('{}');
    t.text('briefing');
    t.boolean('active').notNullable().defaultTo(true);
    ts(t);
  });

  await knex.schema.createTable('opportunity_matches', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('profile_id').notNullable().references('acquisition_profiles.id').onDelete('CASCADE');
    t.integer('score').notNullable();
    t.string('confidence').notNullable();
    t.jsonb('breakdown').notNullable();
    t.string('status').notNullable().defaultTo('suggested'); // suggested | sent | dismissed
    ts(t);
    t.unique(['opportunity_id', 'profile_id']);
  });

  await knex.schema.createTable('favorites', (t) => {
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'opportunity_id']);
  });

  // --------------------------------------------------------------- interesse / WhatsApp
  await knex.schema.createTable('whatsapp_routing_rules', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.string('name').notNullable();
    t.integer('priority').notNullable().defaultTo(100);
    t.jsonb('criteria').notNullable().defaultTo('{}'); // { ufs, cities, types }
    t.string('target').notNullable(); // assigned_broker | round_robin | central
    t.specificType('broker_ids', 'uuid[]').notNullable().defaultTo('{}');
    t.integer('sla_minutes').notNullable().defaultTo(60);
    t.boolean('active').notNullable().defaultTo(true);
    ts(t);
  });

  await knex.schema.createTable('opportunity_interests', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id').onDelete('CASCADE');
    t.string('intent_token', 12).notNullable().unique();
    t.string('status').notNullable().defaultTo('clicked'); // clicked | form_submitted | conversation_started | message_received | qualified | discarded
    t.string('kind').notNullable(); // whatsapp | form
    t.string('channel'); // origem: organic, paid_social, ...
    t.jsonb('attribution').notNullable().defaultTo('{}'); // utm_*, gclid, fbclid...
    t.string('name');
    t.string('email');
    t.string('phone', 20);
    t.string('company');
    t.text('message');
    t.boolean('consent').notNullable().defaultTo(false);
    t.string('legal_basis'); // consentimento | legitimo_interesse | null (sem dado pessoal)
    t.uuid('user_id').references('users.id');
    t.uuid('broker_id').references('land_brokers.id');
    t.string('routed_to_number', 20);
    t.string('routed_via'); // regra aplicada
    t.uuid('rule_id');
    t.timestamp('sla_due_at', { useTz: true });
    t.timestamp('first_response_at', { useTz: true });
    t.string('crm_contact_id');
    t.string('crm_lead_id');
    t.string('crm_sync_status').notNullable().defaultTo('not_applicable'); // not_applicable | pending | synced | failed
    t.uuid('negotiation_id');
    t.string('ip_hash', 64);
    ts(t);
    t.index(['org_id', 'created_at']);
  });

  await knex.schema.createTable('interest_events', (t) => {
    id(t);
    t.uuid('interest_id').notNullable().references('opportunity_interests.id').onDelete('CASCADE');
    t.string('type').notNullable(); // click | form | routed | reassigned | conversation_started | message_received | crm_synced | first_response
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.uuid('user_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('whatsapp_inbound', (t) => {
    id(t);
    t.uuid('org_id').references('organizations.id');
    t.string('wa_message_id').notNullable().unique(); // idempotência
    t.string('from_hash', 64).notNullable();
    t.string('from_masked', 20);
    t.string('to_number', 20);
    t.text('text');
    t.uuid('interest_id').references('opportunity_interests.id');
    t.string('link_status').notNullable(); // linked_token | unlinked | linked_manual
    t.timestamp('received_at', { useTz: true }).notNullable();
    ts(t);
  });

  // --------------------------------------------------------------- negociações
  await knex.schema.createTable('negotiations', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id');
    t.uuid('partner_company_id').references('partner_companies.id');
    t.uuid('interest_id').references('opportunity_interests.id');
    t.string('crm_contact_id');
    t.string('crm_deal_id');
    t.string('contact_name');
    t.string('contact_email');
    t.string('contact_phone', 20);
    t.string('stage').notNullable().defaultTo('interesse_recebido');
    t.string('status').notNullable().defaultTo('open'); // open | won | lost | suspended
    t.uuid('owner_id').references('users.id');
    t.string('proposed_model');
    t.decimal('proposed_value', 16, 2);
    t.string('next_activity');
    t.timestamp('next_activity_at', { useTz: true });
    t.date('expected_close');
    t.string('lost_reason');
    t.integer('version').notNullable().defaultTo(1);
    ts(t);
    t.index(['org_id', 'stage']);
  });

  await knex.schema.createTable('negotiation_participants', (t) => {
    t.uuid('negotiation_id').notNullable().references('negotiations.id').onDelete('CASCADE');
    t.uuid('broker_id').notNullable().references('land_brokers.id');
    t.string('role').notNullable().defaultTo('intermediador');
    t.primary(['negotiation_id', 'broker_id']);
  });

  await knex.schema.createTable('proposals', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('negotiation_id').notNullable().references('negotiations.id').onDelete('CASCADE');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id');
    t.integer('current_version').notNullable().defaultTo(1);
    t.string('status').notNullable().defaultTo('draft'); // draft | submitted | internal_review | approved_internal | countered | accepted | rejected | expired
    t.uuid('created_by').references('users.id');
    ts(t);
  });

  await knex.schema.createTable('proposal_versions', (t) => {
    id(t);
    t.uuid('proposal_id').notNullable().references('proposals.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('side').notNullable(); // comprador | vendedor (contraproposta)
    t.decimal('acquisition_value', 16, 2);
    t.decimal('swap_pct', 5, 2);
    t.jsonb('payment_schedule').notNullable().defaultTo('[]');
    t.text('suspensive_conditions');
    t.integer('analysis_days');
    t.date('valid_until');
    t.text('notes');
    t.specificType('attachment_ids', 'uuid[]').notNullable().defaultTo('{}');
    t.specificType('broker_ids', 'uuid[]').notNullable().defaultTo('{}');
    t.uuid('created_by').references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['proposal_id', 'version']);
  });

  await knex.schema.createTable('proposal_approvals', (t) => {
    id(t);
    t.uuid('proposal_id').notNullable().references('proposals.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.uuid('approver_id').notNullable().references('users.id');
    t.string('decision').notNullable(); // approved | rejected
    t.text('comment');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('commissions', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('negotiation_id').notNullable().references('negotiations.id').onDelete('CASCADE');
    t.uuid('opportunity_id').notNullable().references('land_opportunities.id');
    t.uuid('broker_id').references('land_brokers.id');
    t.string('beneficiary_name').notNullable();
    t.decimal('pct', 5, 2);
    t.decimal('amount', 16, 2);
    t.uuid('contract_document_id').references('land_documents.id');
    t.string('status').notNullable().defaultTo('prevista'); // prevista | contratada | exigivel | paga | cancelada
    t.string('trigger_condition');
    t.date('due_at');
    t.date('paid_at');
    t.jsonb('history').notNullable().defaultTo('[]');
    ts(t);
  });

  await knex.schema.createTable('activities', (t) => {
    id(t);
    t.uuid('org_id').notNullable().references('organizations.id');
    t.uuid('opportunity_id').references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('negotiation_id').references('negotiations.id').onDelete('CASCADE');
    t.string('type').notNullable(); // note | call | meeting | visit | whatsapp | email | task | stage_change | system
    t.string('subject').notNullable();
    t.text('body');
    t.timestamp('due_at', { useTz: true });
    t.timestamp('done_at', { useTz: true });
    t.uuid('user_id').references('users.id');
    t.string('crm_activity_id');
    ts(t);
  });

  // --------------------------------------------------------------- integração / governança
  await knex.schema.createTable('crm_outbox', (t) => {
    id(t);
    t.uuid('org_id').notNullable();
    t.string('kind').notNullable(); // contact.upsert | lead.create | activity.log | deal.upsert
    t.jsonb('payload').notNullable();
    t.string('idempotency_key').notNullable().unique();
    t.string('status').notNullable().defaultTo('pending'); // pending | done | dead
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('last_error');
    t.jsonb('result');
    ts(t);
  });

  // Espelho usado SOMENTE no modo embutido (sem WINGSBR_CRM_URL). Não é um CRM: é um stub de desenvolvimento.
  await knex.schema.createTable('crm_contacts', (t) => {
    t.string('id').primary();
    t.uuid('org_id').notNullable();
    t.string('name');
    t.string('email');
    t.string('phone', 20);
    t.string('company');
    t.jsonb('tags').notNullable().defaultTo('[]');
    ts(t);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.uuid('org_id');
    t.uuid('user_id');
    t.string('action').notNullable();
    t.string('entity').notNullable();
    t.string('entity_id');
    t.jsonb('diff');
    t.string('ip_hash', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['org_id', 'entity', 'entity_id']);
  });

  await knex.schema.createTable('ai_suggestions', (t) => {
    id(t);
    t.uuid('org_id').notNullable();
    t.uuid('opportunity_id').references('land_opportunities.id').onDelete('CASCADE');
    t.uuid('negotiation_id').references('negotiations.id').onDelete('CASCADE');
    t.string('kind').notNullable();
    t.jsonb('content').notNullable();
    t.string('origin').notNullable(); // heuristic | anthropic:<model>
    t.string('status').notNullable().defaultTo('suggested'); // suggested | accepted | rejected
    t.uuid('requested_by');
    t.uuid('validated_by');
    ts(t);
  });
}

export async function down(knex: Knex): Promise<void> {
  const tables = ['ai_suggestions','audit_logs','crm_contacts','crm_outbox','activities','commissions','proposal_approvals','proposal_versions','proposals','negotiation_participants','negotiations','whatsapp_inbound','interest_events','opportunity_interests','whatsapp_routing_rules','favorites','opportunity_matches','acquisition_profiles','partner_companies','broker_assignments','land_media','land_documents','land_owners','publication_permissions','land_commercial_terms','land_technical_attributes','land_geometries','land_opportunities','land_brokers','permissions','roles','users','organizations'];
  for (const t of tables) await knex.schema.dropTableIfExists(t);
}
