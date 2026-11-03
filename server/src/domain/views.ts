/**
 * Regras puras de visibilidade (sem banco): o que cada público vê de uma oportunidade.
 * Usadas pela API e pela demonstração no navegador — uma única fonte de verdade.
 */
import { LAND_TYPES, slugify, type LandType, type Role } from '@dl/shared';
import { grant, DOC_VISIBILITY } from '../auth/permissions.js';

/** Ponto aproximado determinístico quando não há perímetro (mesma semente → mesmo ponto). */
export function approxPoint(lat: number, lng: number, seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const r1 = ((Math.abs(h) % 1000) / 1000 - 0.5) * 0.008;
  const r2 = ((Math.abs(h >> 10) % 1000) / 1000 - 0.5) * 0.008;
  return [Math.round(lng * 100) / 100 + r1, Math.round(lat * 100) / 100 + r2];
}

export function buildSlug(o: { code: string; public_title?: string | null; type?: string | null; city?: string | null }) {
  const label = o.public_title || [LAND_TYPES[o.type as LandType], o.city].filter(Boolean).join(' ');
  return slugify(`${o.code} ${label}`);
}

const mediaUrl = (m: any) => ({ id: m.id, url: `/${m.storage_key}`, caption: m.caption, is_cover: m.is_cover, width: m.width, height: m.height });

/** Parâmetros técnicos exibidos publicamente (sem notas internas). */
const PUBLIC_TECH = ['situacao', 'perimetro_urbano', 'zoneamento', 'uso_solo', 'coef_aproveitamento', 'taxa_ocupacao', 'gabarito', 'agua', 'energia', 'esgoto', 'infra_viaria', 'acesso_rodovias', 'estagio_aprovacao', 'viabilidade', 'parcelamento'];

function locationFor(o: any, rel: any, precision: string) {
  const g = rel.geometry;
  if (!g) {
    if (o.lat == null || o.lng == null) return null;
    if (precision === 'exact') return { precision, point: [o.lng, o.lat], radius_m: null };
    return { precision, point: approxPoint(o.lat, o.lng, o.id), radius_m: precision === 'approximate' ? 1200 : 6000 };
  }
  if (precision === 'exact') return { precision, point: [g.c_lng, g.c_lat], radius_m: null, polygon: g.geometry };
  return { precision, point: [g.p_lng, g.p_lat], radius_m: precision === 'approximate' ? 1200 : 6000 };
}

function pricePerM2(terms: any, area: number | null) {
  return terms?.asking_price && area ? Math.round((terms.asking_price / area) * 100) / 100 : null;
}

/** Visão pública/vitrine — só o que a publicação autoriza. */
export function publicView(o: any, rel: any) {
  const pub = rel.pub ?? {};
  const terms = rel.terms ?? {};
  const precision = pub.location_precision ?? 'region';
  const primary = rel.assignments.find((a: any) => a.role === 'primary');
  return {
    code: o.code,
    slug: o.slug,
    title: o.public_title ?? o.internal_name,
    type: o.type,
    status: o.status,
    city: o.city,
    uf: o.uf,
    neighborhood: precision === 'region' ? null : o.neighborhood,
    region: o.region,
    address: precision === 'exact' ? o.address : null,
    area_m2: o.area_m2,
    usable_area_m2: o.usable_area_m2,
    frontage_m: o.frontage_m,
    depth_m: o.depth_m,
    topography: o.topography,
    summary: o.summary,
    strategic_description: o.strategic_description,
    featured: o.featured,
    visibility: o.visibility,
    published_at: o.published_at,
    updated_at: o.updated_at,
    commercial: {
      modalities: terms.modalities ?? [],
      asking_price: pub.show_price ? terms.asking_price : null,
      price_per_m2: pub.show_price_per_m2 ? pricePerM2(terms, o.area_m2) : null,
      swap_pct: pub.show_price ? terms.swap_pct : null,
      expected_units: terms.expected_units ?? null,
      vgv_preliminary: pub.show_price ? terms.vgv_preliminary : null,
      negotiable: terms.negotiable ?? true,
      exclusivity: !!terms.exclusivity,
      price_hidden: !pub.show_price,
    },
    technical: Object.fromEntries(
      PUBLIC_TECH.filter((k) => rel.tech[k]?.value != null).map((k) => [k, { value: rel.tech[k].value, validation_status: rel.tech[k].validation_status }]),
    ),
    media: rel.media.map(mediaUrl),
    location: locationFor(o, rel, precision),
    documents: pub.show_public_documents
      ? rel.documents.filter((d: any) => d.confidentiality === 'public').map((d: any) => ({ id: d.id, title: d.title, category: d.category, mime: d.mime, size: d.size }))
      : [],
    broker: primary ? { name: primary.name.split(' ')[0], creci: primary.creci_status === 'ativo' ? `${primary.creci}-${primary.creci_uf}` : null } : null,
  };
}

/** Visão interna — campos condicionados à matriz de permissões do papel. */
export function internalView(o: any, rel: any, role: Role, brokerId: string | null, decrypt: (s: string | null) => string | null = () => null) {
  const canCommission = !!grant(role, 'commission', 'read') && grant(role, 'commission', 'read') !== 'own';
  const canOwners = !!grant(role, 'owner_data', 'read');
  const canExact = !!grant(role, 'exact_location', 'read');
  const canTerms = !!grant(role, 'commercial_terms', 'read');
  const terms = rel.terms ? { ...rel.terms } : null;
  if (terms && !canCommission) { delete terms.commission_total_pct; delete terms.commission_split; }
  if (terms && !canOwners) delete terms.internal_notes;
  const g = rel.geometry;
  const docsAllowed = DOC_VISIBILITY[role] ?? [];
  return {
    ...o,
    price_per_m2: pricePerM2(rel.terms, o.area_m2),
    address: canExact || role === 'owner' ? o.address : null,
    lat: canExact ? o.lat : null,
    lng: canExact ? o.lng : null,
    geometry: g
      ? {
          area_m2: g.area_m2, perimeter_m: g.perimeter_m, source: g.source, version: g.version,
          geometry: canExact || role === 'owner' ? g.geometry : null,
          public_point: [g.p_lng, g.p_lat],
        }
      : null,
    technical: rel.tech,
    terms: canTerms ? terms : null,
    publication: rel.pub,
    media: rel.media.map(mediaUrl),
    owners: canOwners
      ? rel.owners.map((x: any) => ({ ...x, document: x.document ?? decrypt(x.document_enc), document_enc: undefined }))
      : [],
    documents: rel.documents
      .filter((d: any) => docsAllowed.includes(d.confidentiality))
      .map((d: any) => ({ ...d, storage_key: undefined })),
    assignments: rel.assignments,
    is_my_assignment: !!brokerId && rel.assignments.some((a: any) => a.broker_id === brokerId),
  };
}

/** Checagem para envio à revisão de publicação. Retorna lista de pendências. */
export function publicationChecklist(o: any, rel: any): string[] {
  const missing: string[] = [];
  if (!o.public_title) missing.push('Título comercial público');
  if (!o.type) missing.push('Tipo da área');
  if (!o.city || !o.uf) missing.push('Cidade e UF');
  if (!o.area_m2) missing.push('Área total');
  if (!rel.geometry && o.lat == null) missing.push('Localização (perímetro ou coordenadas)');
  if (!rel.media.length) missing.push('Ao menos uma imagem');
  if (!rel.terms?.modalities?.length) missing.push('Modalidade de negociação');
  const hasAuthDoc = rel.documents.some((d: any) => d.category === 'authorization');
  if (!hasAuthDoc && !rel.pub?.legal_basis) missing.push('Autorização de divulgação (documento ou base jurídica)');
  if (!rel.assignments.some((a: any) => a.role === 'primary')) missing.push('Intermediador responsável');
  return missing;
}
