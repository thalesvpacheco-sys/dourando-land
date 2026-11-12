import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { LAND_TYPES, MODALITIES, TECHNICAL_KEYS, formatArea, formatBRL, type LandType, type Modality, type TechnicalKey } from '@dl/shared';
import { api, DEMO, FRAMED } from '../lib/api';
import MapView from '../components/MapView';
import { Brand, Loading } from '../components/ui';
import { techValue, toFeature } from './Detail';
import type { PublicArea } from './Ficha';

/** Apresentação digital (book) em A4 paisagem, gerada só com dados aprovados para a vitrine. */
export default function Book() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const print = params.get('print') === '1';
  const [a, setA] = useState<PublicArea | null>(null);
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => { api<PublicArea>(`/api/public/opportunities/${slug}`).then((r) => { setA(r); document.title = `Book ${r.code}`; }); }, [slug]);
  useEffect(() => { if (a) { const t = setTimeout(() => setMapReady(true), 1500); return () => clearTimeout(t); } }, [a]);
  const features = useMemo(() => (a ? toFeature(a) : []), [a]);
  if (!a) return <div className="page"><Loading /></div>;
  const date = new Date().toLocaleDateString('pt-BR');
  const foot = (n: number) => <div className="book-foot"><span>{a.code} · Dourado Real Estate Partners</span><span>Informações sujeitas a confirmação. Parâmetros não verificados não constituem aprovação oficial. Gerado em {date}.</span><span>{n}/3</span></div>;

  return (
    <div className="book" data-book-ready={mapReady ? '' : undefined}>
      {!print && (
        <div className="book-toolbar">
          <Link to={`/areas/${a.slug}`} style={{ color: '#fff' }}>Voltar à área</Link>
          {FRAMED ? <span className="small" style={{ color: '#c3cbc8' }}>Em produção: Baixar PDF e Imprimir (bloqueados no frame da demonstração)</span> : <div className="row">
            <a className="btn ghost small" style={{ color: '#fff', borderColor: '#5a6b70' }} href={`/api/public/opportunities/${a.slug}/book.pdf`}>Baixar PDF</a>
            <button className="btn gold small" onClick={() => window.print()}>Imprimir / salvar PDF</button>
          </div>}
        </div>
      )}
      <section className="book-page book-cover">
        {a.media[0] ? <img src={a.media[0].url} alt="" /> : <div style={{ background: 'var(--paper-2)' }} />}
        <div className="txt">
          <div className="brand" style={{ display: 'flex' }}><Brand /></div>
          <div>
            <p className="muted">{a.code}</p>
            <h1>{a.title}</h1>
            <p style={{ fontSize: '13pt', marginTop: '4mm' }}>{a.city}/{a.uf}{a.region ? ` — ${a.region}` : ''}</p>
          </div>
          <dl className="facts" style={{ margin: 0 }}>
            <div><dt>Área total</dt><dd>{formatArea(a.area_m2)}</dd></div>
            <div><dt>Tipo</dt><dd style={{ fontSize: '11pt' }}>{LAND_TYPES[a.type as LandType]}</dd></div>
            <div><dt>Valor</dt><dd style={{ fontSize: '11pt' }}>{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Sob consulta'}</dd></div>
          </dl>
        </div>
      </section>
      <section className="book-page book-inner">
        <div>
          <h2>A oportunidade</h2>
          <p style={{ fontSize: '11pt' }}>{a.summary}</p>
          <p style={{ fontSize: '10pt', color: 'var(--ink-2)' }}>{a.strategic_description}</p>
          <h2 style={{ marginTop: '6mm' }}>Condições</h2>
          <dl className="spec" style={{ fontSize: '10pt' }}>
            <dt>Modalidades</dt><dd>{a.commercial.modalities.map((m) => MODALITIES[m as Modality]).join(', ')}</dd>
            <dt>Valor pedido</dt><dd>{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Sob consulta'}</dd>
            {a.commercial.price_per_m2 && <><dt>Valor por m²</dt><dd>{formatBRL(a.commercial.price_per_m2)}</dd></>}
            {a.commercial.swap_pct && <><dt>Permuta pretendida</dt><dd>{a.commercial.swap_pct}%</dd></>}
          </dl>
        </div>
        <div style={{ height: '150mm', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--line)', position: 'relative' }}>
          <MapView features={features} legend={false} interactive={false} />
        </div>
        {foot(2)}
      </section>
      <section className="book-page book-inner">
        <div>
          <h2>Parâmetros técnicos</h2>
          <dl className="spec" style={{ fontSize: '9.5pt' }}>
            {Object.entries(a.technical).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{TECHNICAL_KEYS[k as TechnicalKey]?.label ?? k}</dt>
                <dd><span>{techValue(k, v.value)}</span><span className="small muted">{({ oficial: 'documento oficial', verificado: 'verificado', declarado: 'declarado', nao_verificado: 'não verificado' } as any)[v.validation_status]}</span></dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="stack">
          {a.media.slice(1, 3).map((m) => <img key={m.id} src={m.url} alt={m.caption ?? ''} style={{ borderRadius: 4, height: '62mm', objectFit: 'cover', width: '100%' }} />)}
          <div className="notice" style={{ fontSize: '10pt' }}>
            Atendimento {a.broker ? `com ${a.broker.name}${a.broker.creci ? `, CRECI ${a.broker.creci}` : ''}` : 'Dourado'}. Para matrícula, certidões e estudos completos, solicite pelo código {a.code}.
          </div>
        </div>
        {foot(3)}
      </section>
    </div>
  );
}
