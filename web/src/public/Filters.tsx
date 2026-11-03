import { useEffect, useState } from 'react';
import { APPROVAL_STAGES, LAND_TYPES, MODALITIES, VIABILITY } from '@dl/shared';
import { api } from '../lib/api';

export type FilterState = Record<string, string>;

export interface Meta { ufs: { uf: string; n: number }[]; cities: { city: string; uf: string; n: number }[]; totals: { n: number; area: number; cities: number } }

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { api<Meta>('/api/public/meta').then(setMeta).catch(() => {}); }, []);
  return meta;
}

const toggleCsv = (csv: string | undefined, v: string) => {
  const s = new Set((csv ?? '').split(',').filter(Boolean));
  s.has(v) ? s.delete(v) : s.add(v);
  return [...s].join(',');
};

/** Filtros combináveis (seção 6). Estado vive na URL, então a busca é compartilhável. */
export default function Filters({ value, onChange, meta }: { value: FilterState; onChange: (v: FilterState) => void; meta: Meta | null }) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v, page: '' });
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commitNum = (k: string, mult = 1) => {
    const raw = local[k];
    onChange({ ...value, [k]: raw ? String(Number(raw) * mult) : '', page: '' });
  };
  const ha = (k: string) => (value[k] ? String(Number(value[k]) / 10000) : '');
  const cities = (meta?.cities ?? []).filter((c) => !value.uf || c.uf === value.uf);

  return (
    <>
      <fieldset>
        <legend>Estado e cidade</legend>
        <select className="input" aria-label="Estado" value={value.uf ?? ''} onChange={(e) => onChange({ ...value, uf: e.target.value, city: '', page: '' })}>
          <option value="">Todos os estados</option>
          {meta?.ufs.map((u) => <option key={u.uf} value={u.uf}>{u.uf} ({u.n})</option>)}
        </select>
        <select className="input" aria-label="Cidade" value={value.city ?? ''} onChange={(e) => set('city', e.target.value)}>
          <option value="">Todas as cidades</option>
          {cities.map((c) => <option key={c.city + c.uf} value={c.city}>{c.city} ({c.n})</option>)}
        </select>
        <input className="input" placeholder="Região (ex.: metropolitana)" aria-label="Região" value={local.region ?? ''} onChange={(e) => setLocal({ ...local, region: e.target.value })} onBlur={() => set('region', local.region ?? '')} />
      </fieldset>

      <fieldset>
        <legend>Área total (hectares)</legend>
        <div className="range">
          <input className="input" inputMode="decimal" placeholder="Mín." aria-label="Área mínima em hectares" value={local.area_min_ha ?? ha('area_min')} onChange={(e) => setLocal({ ...local, area_min_ha: e.target.value })} onBlur={() => { onChange({ ...value, area_min: local.area_min_ha ? String(Number(local.area_min_ha.replace(',', '.')) * 10000) : '', page: '' }); }} />
          <input className="input" inputMode="decimal" placeholder="Máx." aria-label="Área máxima em hectares" value={local.area_max_ha ?? ha('area_max')} onChange={(e) => setLocal({ ...local, area_max_ha: e.target.value })} onBlur={() => { onChange({ ...value, area_max: local.area_max_ha ? String(Number(local.area_max_ha.replace(',', '.')) * 10000) : '', page: '' }); }} />
        </div>
      </fieldset>

      <fieldset>
        <legend>Valor (R$ milhões)</legend>
        <div className="range">
          <input className="input" inputMode="decimal" placeholder="Mín." aria-label="Valor mínimo em milhões" value={local.price_min_mi ?? (value.price_min ? String(+value.price_min / 1e6) : '')} onChange={(e) => setLocal({ ...local, price_min_mi: e.target.value })} onBlur={() => onChange({ ...value, price_min: local.price_min_mi ? String(Number(local.price_min_mi.replace(',', '.')) * 1e6) : '', page: '' })} />
          <input className="input" inputMode="decimal" placeholder="Máx." aria-label="Valor máximo em milhões" value={local.price_max_mi ?? (value.price_max ? String(+value.price_max / 1e6) : '')} onChange={(e) => setLocal({ ...local, price_max_mi: e.target.value })} onBlur={() => onChange({ ...value, price_max: local.price_max_mi ? String(Number(local.price_max_mi.replace(',', '.')) * 1e6) : '', page: '' })} />
        </div>
        <small className="muted">Considera apenas áreas com valor divulgado.</small>
      </fieldset>

      <fieldset>
        <legend>Valor por m² (R$)</legend>
        <div className="range">
          <input className="input" inputMode="decimal" placeholder="Mín." aria-label="Valor por metro quadrado mínimo" value={local.ppm2_min ?? ''} onChange={(e) => setLocal({ ...local, ppm2_min: e.target.value })} onBlur={() => commitNum('ppm2_min')} />
          <input className="input" inputMode="decimal" placeholder="Máx." aria-label="Valor por metro quadrado máximo" value={local.ppm2_max ?? ''} onChange={(e) => setLocal({ ...local, ppm2_max: e.target.value })} onBlur={() => commitNum('ppm2_max')} />
        </div>
      </fieldset>

      <fieldset>
        <legend>Negociação</legend>
        <div className="chips">
          {Object.entries(MODALITIES).map(([k, l]) => (
            <button type="button" key={k} className="chip" aria-pressed={(value.modality ?? '').split(',').includes(k)} onClick={() => set('modality', toggleCsv(value.modality, k))}>{l}</button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Tipo de desenvolvimento</legend>
        <div className="chips">
          {Object.entries(VIABILITY).map(([k, l]) => (
            <button type="button" key={k} className="chip" aria-pressed={(value.viability ?? '').split(',').includes(k)} onClick={() => set('viability', toggleCsv(value.viability, k))}>{l}</button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Tipo de área</legend>
        <select className="input" aria-label="Tipo de área" value={value.type ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">Todos</option>
          {Object.entries(LAND_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>Estágio de aprovação mínimo</legend>
        <select className="input" aria-label="Estágio de aprovação mínimo" value={value.approval ?? ''} onChange={(e) => set('approval', e.target.value)}>
          <option value="">Qualquer</option>
          {Object.entries(APPROVAL_STAGES).slice(1).map(([k, l]) => <option key={k} value={k}>{l} ou mais</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>Infraestrutura disponível</legend>
        {[['agua', 'Água'], ['energia', 'Energia'], ['esgoto', 'Esgoto']].map(([k, l]) => (
          <label key={k} className="check"><input type="checkbox" checked={(value.infra ?? '').split(',').includes(k)} onChange={() => set('infra', toggleCsv(value.infra, k))} /> {l}</label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Disponibilidade</legend>
        <select className="input" aria-label="Disponibilidade" value={value.status ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">Disponíveis e em negociação</option>
          <option value="disponivel">Somente disponíveis</option>
          <option value="em_negociacao,sob_exclusividade">Em negociação</option>
        </select>
      </fieldset>
    </>
  );
}

export const FILTER_KEYS = ['q', 'uf', 'city', 'region', 'area_min', 'area_max', 'price_min', 'price_max', 'ppm2_min', 'ppm2_max', 'modality', 'viability', 'type', 'approval', 'infra', 'status', 'featured'];
