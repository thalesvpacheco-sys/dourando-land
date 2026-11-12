import { useState } from 'react';
import { formatArea, TERRITORY_LAYERS, type TerritoryLayer } from '@dl/shared';
import { api } from '../lib/api';

/** Sobreposição do perímetro com parcelas certificadas (SIGEF/INCRA) e imóveis do CAR — apoio à diligência, não substitui certidões. */
export default function OverlapPanel({ url }: { url: string }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true); setErr('');
    try { setData(await api(url)); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="panel stack-s">
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <h2>Sobreposição com SIGEF e CAR</h2>
        <button type="button" className="btn ghost small" disabled={busy} onClick={run}>{busy ? 'Consultando bases…' : data ? 'Consultar de novo' : 'Analisar sobreposição'}</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Cruza o perímetro com imóveis certificados no SIGEF/INCRA e cadastrados no CAR. Use para conferir a matrícula e o georreferenciamento; não substitui certidões nem a consulta ao Registro de Imóveis.</p>
      {err && <p className="error-text">{err}</p>}
      {data && (data.message ? <p className="small">{data.message}</p> : data.items.length === 0 ? <p className="notice ok" style={{ margin: 0 }}>Nenhuma parcela sobreposta nas bases consultadas.</p> : (
        <>
          {data.mode === 'demo' && <p className="notice" style={{ margin: 0 }}>Modo demonstração: parcelas fictícias, geradas para teste.</p>}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Base</th><th>Código</th><th>Imóvel</th><th className="r">Sobreposição</th><th className="r">% da área</th><th className="r">% da parcela</th><th>Situação</th></tr></thead>
              <tbody>{data.items.map((i: any, k: number) => (
                <tr key={k}>
                  <td>{TERRITORY_LAYERS[i.layer as TerritoryLayer]?.short ?? i.layer}</td>
                  <td className="small" style={{ wordBreak: 'break-all', maxWidth: 220 }}>{i.properties.codigo}</td>
                  <td className="small">{i.properties.nome ?? '—'}{i.properties.matricula && <div className="muted">Matrícula {i.properties.matricula}</div>}</td>
                  <td className="r num">{formatArea(i.intersection_m2)}</td>
                  <td className="r num">{i.pct_of_area.toFixed(1)}%</td>
                  <td className="r num">{i.pct_of_parcel.toFixed(1)}%</td>
                  <td className="small">{i.properties.situacao ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Fonte: {[...new Set(data.items.map((i: any) => i.properties.fonte))].join('; ')}. Consulta em {new Date(data.items[0].consulted_at).toLocaleString('pt-BR')}.</p>
        </>
      ))}
    </div>
  );
}
