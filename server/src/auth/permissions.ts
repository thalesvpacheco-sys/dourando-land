import type { Role } from '@dl/shared';

export type Action = 'read' | 'create' | 'update' | 'delete' | 'export' | 'share' | 'approve';
/**
 * Escopos:
 *  all       – todas as organizações (somente plataforma)
 *  org       – tudo dentro da organização do usuário
 *  assigned  – apenas oportunidades/negociações atribuídas ao intermediador
 *  own       – apenas o que pertence ao usuário (proprietário: suas áreas; comprador: suas negociações/perfis)
 *  published – vitrine (pública + privada) — compradores
 */
export type Scope = 'all' | 'org' | 'assigned' | 'own' | 'published';

export type Resource =
  | 'organization' | 'integration' | 'user' | 'audit'
  | 'opportunity' | 'commercial_terms' | 'owner_data' | 'exact_location' | 'document' | 'publication'
  | 'interest' | 'routing' | 'negotiation' | 'proposal' | 'commission'
  | 'partner' | 'profile' | 'match' | 'dashboard' | 'ai'
  | 'prospect' | 'territory';

type Grant = { actions: Action[]; scope: Scope };
type Matrix = Record<Role, Partial<Record<Resource, Grant>>>;

const ALL: Action[] = ['read', 'create', 'update', 'delete', 'export', 'share', 'approve'];
const RW: Action[] = ['read', 'create', 'update'];

export const MATRIX: Matrix = {
  // Infraestrutura sem acesso comercial por padrão.
  platform_admin: {
    organization: { actions: RW, scope: 'all' },
    integration: { actions: ['read', 'update'], scope: 'all' },
    user: { actions: RW, scope: 'all' },
    audit: { actions: ['read'], scope: 'all' },
  },
  dourado_admin: {
    user: { actions: RW, scope: 'org' },
    audit: { actions: ['read', 'export'], scope: 'org' },
    integration: { actions: ['read'], scope: 'org' },
    opportunity: { actions: ALL, scope: 'org' },
    commercial_terms: { actions: ALL, scope: 'org' },
    owner_data: { actions: ALL, scope: 'org' },
    exact_location: { actions: ['read', 'update'], scope: 'org' },
    document: { actions: ALL, scope: 'org' },
    publication: { actions: ALL, scope: 'org' },
    interest: { actions: ALL, scope: 'org' },
    routing: { actions: ALL, scope: 'org' },
    negotiation: { actions: ALL, scope: 'org' },
    proposal: { actions: ALL, scope: 'org' },
    commission: { actions: ALL, scope: 'org' },
    partner: { actions: ALL, scope: 'org' },
    profile: { actions: ALL, scope: 'org' },
    match: { actions: ALL, scope: 'org' },
    dashboard: { actions: ['read', 'export'], scope: 'org' },
    ai: { actions: ['read', 'create'], scope: 'org' },
    prospect: { actions: ALL, scope: 'org' },
    territory: { actions: ['read'], scope: 'org' },
  },
  capture_manager: {
    opportunity: { actions: [...RW, 'share'], scope: 'org' },
    commercial_terms: { actions: RW, scope: 'org' },
    owner_data: { actions: RW, scope: 'org' },
    exact_location: { actions: ['read', 'update'], scope: 'org' },
    document: { actions: [...RW, 'approve'], scope: 'org' }, // valida documentos
    publication: { actions: ['read', 'create'], scope: 'org' }, // envia para revisão, não aprova
    interest: { actions: ['read'], scope: 'org' },
    negotiation: { actions: ['read'], scope: 'org' },
    partner: { actions: RW, scope: 'org' },
    profile: { actions: RW, scope: 'org' },
    match: { actions: ['read', 'create'], scope: 'org' },
    dashboard: { actions: ['read'], scope: 'org' },
    ai: { actions: ['read', 'create'], scope: 'org' },
    prospect: { actions: [...RW, 'approve'], scope: 'org' }, // approve = converter em área
    territory: { actions: ['read'], scope: 'org' },
  },
  broker: {
    opportunity: { actions: ['read', 'share'], scope: 'assigned' },
    commercial_terms: { actions: ['read'], scope: 'assigned' },
    document: { actions: ['read'], scope: 'assigned' },
    interest: { actions: ['read', 'update'], scope: 'assigned' },
    negotiation: { actions: RW, scope: 'assigned' },
    proposal: { actions: RW, scope: 'assigned' },
    commission: { actions: ['read'], scope: 'own' },
    match: { actions: ['read'], scope: 'assigned' },
    ai: { actions: ['read', 'create'], scope: 'assigned' },
    prospect: { actions: RW, scope: 'own' }, // indicações trazidas pelo próprio parceiro
    territory: { actions: ['read'], scope: 'org' },
  },
  owner: {
    opportunity: { actions: ['read'], scope: 'own' },
    document: { actions: ['read', 'create'], scope: 'own' },
  },
  buyer: {
    opportunity: { actions: ['read', 'share'], scope: 'published' },
    profile: { actions: [...RW, 'delete'], scope: 'own' },
    negotiation: { actions: ['read'], scope: 'own' },
    proposal: { actions: ['read', 'create'], scope: 'own' },
    match: { actions: ['read'], scope: 'own' },
  },
};

export const PRIVILEGED: Role[] = ['platform_admin', 'dourado_admin', 'capture_manager'];

export function grant(role: Role, resource: Resource, action: Action): Scope | null {
  const g = MATRIX[role]?.[resource];
  return g && g.actions.includes(action) ? g.scope : null;
}

/** Documentos visíveis por papel, pela classificação de confidencialidade. */
export const DOC_VISIBILITY: Record<Role, string[]> = {
  platform_admin: [],
  dourado_admin: ['public', 'internal', 'confidential', 'restricted'],
  capture_manager: ['public', 'internal', 'confidential', 'restricted'],
  broker: ['public', 'internal', 'restricted'],
  owner: ['public', 'internal', 'confidential'], // vê os documentos da própria área
  buyer: ['public'],
};
