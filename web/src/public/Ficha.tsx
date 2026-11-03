import { Link } from 'react-router-dom';
import { formatArea, formatBRL, LAND_TYPES, MODALITIES, type LandType, type Modality } from '@dl/shared';

export interface PublicArea {
  code: string; slug: string; title: string; type: string; status: string; city: string; uf: string; neighborhood: string | null; region: string | null;
  area_m2: number; usable_area_m2: number | null; frontage_m: number | null; depth_m: number | null; topography: string | null;
  summary: string | null; strategic_description: string | null; featured: boolean;
  commercial: { modalities: string[]; asking_price: number | null; price_per_m2: number | null; swap_pct: number | null; expected_units: number | null; vgv_preliminary: number | null; negotiable: boolean; exclusivity: boolean; price_hidden: boolean };
  technical: Record<string, { value: any; validation_status: string }>;
  media: { id: string; url: string; caption: string | null }[];
  location: { precision: string; point: [number, number] | null; radius_m: number | null; polygon?: any } | null;
  documents: { id: string; title: string; category: string; mime: string; size: number }[];
  broker: { name: string; creci: string | null } | null;
  similar?: PublicArea[]; canonical_slug?: string; favorite?: boolean; visibility?: string;
}

export const statusLabel: Record<string, [string, string]> = {
  disponivel: ['ok', 'Disponível'], em_negociacao: ['warn', 'Em negociação'], sob_exclusividade: ['warn', 'Sob exclusividade'],
};

/** Ficha cadastral: a metragem é o elemento tipográfico principal. */
export default function Ficha({ a }: { a: PublicArea }) {
  const st = statusLabel[a.status];
  const ha = a.area_m2 >= 10000;
  return (
    <Link to={`/areas/${a.slug}`} className="ficha">
      <div className="ficha-area">
        <b className="num">{ha ? (a.area_m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : Math.round(a.area_m2).toLocaleString('pt-BR')}</b>
        <span>{ha ? 'hectares' : 'm²'}{a.usable_area_m2 ? ` · ${formatArea(a.usable_area_m2)} aproveitáveis` : ''}</span>
      </div>
      <div>
        <span className="ficha-code">{a.code}</span>
        <h3 className="ficha-title">{a.title}</h3>
        <div className="ficha-meta">
          <span>{a.city}/{a.uf}{a.region ? ` — ${a.region}` : ''}</span>
          <span>{LAND_TYPES[a.type as LandType]}</span>
          <span>{a.commercial.modalities.map((m) => MODALITIES[m as Modality]).join(', ')}</span>
        </div>
        <div className="row" style={{ marginTop: '0.6rem', gap: '0.5rem' }}>
          {st && <span className={`badge dot ${st[0]}`}>{st[1]}</span>}
          {a.featured && <span className="badge ink">Destaque</span>}
          {a.visibility === 'private' && <span className="badge">Vitrine exclusiva</span>}
          <span className="ficha-price">{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Valor sob consulta'}</span>
          {a.commercial.price_per_m2 && <span className="muted small">{formatBRL(a.commercial.price_per_m2)}/m²</span>}
        </div>
      </div>
      <div className="ficha-img">{a.media[0] && <img src={a.media[0].url} alt={a.media[0].caption ?? ''} loading="lazy" />}</div>
    </Link>
  );
}
