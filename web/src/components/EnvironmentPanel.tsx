import { useState } from 'react';
import { formatArea } from '@dl/shared';
import { api, DEMO } from '../lib/api';

/**
 * Análise ambiental e restrições do perímetro. A área aproveitável desconta a união de APP, Reserva Legal, hidrografia e
 * uso restrito (essas camadas se sobrepõem). É estimativa de triagem: o CAR é declaratório.
 */
export default function EnvironmentPanel({ url, onApply }: { url: string; onApply?: (m2: number) => Promise<void> }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (DEMO) return null;
  const run = async () => {
    setBusy(true); setErr('');
    try { setData(await api(url)); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="panel stack-s">
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <h2>Análise ambiental e restrições</h2>
        <button type="button" className="btn ghost small" disabled={busy} onClick={run}>{busy ? 'Calculando…' : data ? 'Calcular de novo' : 'Analisar perímetro'}</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Cruza o perímetro com as bases carregadas. Serve para triagem e não substitui levantamento, certidões nem análise jurídica.</p>
      {err && <p className="error-text">{err}</p>}
      {data?.message && <p className="small">{data.message}</p>}
      {data && !data.message && <>
        {data.restrictions.length > 0
          ? <div className="notice bad" style={{ margin: 0 }}><b>Sobreposição com restrição:</b><ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>{data.restrictions.map((r: any) => <li key={r.layer}>{r.label}: {formatArea(r.area_m2)} ({r.pct.toFixed(1)}%){r.names?.[0] ? ` — ${r.names.join(', ')}` : ''}</li>)}</ul></div>
          : <p className="notice ok" style={{ margin: 0 }}>Nenhuma sobreposição com as restrições carregadas.</p>}
        {data.layers.length > 0 && <div className="table-wrap"><table className="data"><thead><tr><th>Camada</th><th className="r">Área</th><th className="r">% do perímetro</th><th>Desconta</th></tr></thead>
          <tbody>{data.layers.map((l: any) => <tr key={l.layer}><td><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: l.color, marginRight: 6 }} />{l.label}</td><td className="r num">{formatArea(l.area_m2)}</td><td className="r num">{l.pct.toFixed(1)}%</td><td className="small">{l.deducts ? 'Sim' : 'Não'}</td></tr>)}</tbody></table></div>}
        {data.usable_m2 != null
          ? <div className="spread"><span>Área aproveitável estimada: <b>{formatArea(data.usable_m2)}</b> <span className="muted small">de {formatArea(data.area_m2)}</span></span>
              {onApply && <button type="button" className="btn small" onClick={() => void onApply(Math.round(data.usable_m2))}>Usar este valor na área</button>}</div>
          : <p className="small muted" style={{ margin: 0 }}>Área aproveitável não calculada: falta carregar {data.usable_requires.join(' e ')}.</p>}
        {data.not_loaded.length > 0 && <details className="small"><summary>{data.not_loaded.length} bases não consideradas (ainda não carregadas)</summary><p className="muted" style={{ margin: '0.3rem 0 0' }}>{data.not_loaded.map((l: any) => l.label).join(', ')}.</p></details>}
      </>}
    </div>
  );
}
