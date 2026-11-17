import { useEffect, useRef, useState } from 'react';
import { earthUrl, toKml } from '@dl/shared';
import { DEMO, downloadFile, getToken } from '../lib/api';
import { useToast } from './ui';

const GMAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
/** Há chave do Google Maps neste build (a vista 3D pode ser exibida). */
export const HAS_GOOGLE_3D = !!GMAPS_KEY && !DEMO;

/**
 * Google Earth: não há API de incorporação do Earth Web. A integração é feita por:
 *  1) link que abre o Earth exatamente na área (coordenadas e distância da câmera);
 *  2) KML do perímetro no estilo da marca, para importar em um projeto do Earth (Projetos → Novo → Importar arquivo KML).
 * A vista 3D dentro da plataforma usa o Google 3D Maps (Maps JavaScript API) quando há chave configurada.
 */
export function EarthTools({ lat, lng, areaM2, name, geometry, kmlUrl }: { lat: number; lng: number; areaM2?: number | null; name: string; geometry?: any; kmlUrl?: string }) {
  const toast = useToast();
  const dist = areaM2 ? Math.max(800, Math.sqrt(areaM2) * 4) : 2500;
  const exportKml = async () => {
    try {
      let kml: string;
      if (kmlUrl && !DEMO) {
        const t = getToken();
        const r = await fetch(kmlUrl, t ? { headers: { Authorization: `Bearer ${t}` } } : undefined);
        if (!r.ok) throw new Error('Sem permissão para exportar o perímetro');
        kml = await r.text();
      } else kml = toKml({ name, geometry, point: [lng, lat] });
      if (DEMO) {
        await navigator.clipboard.writeText(kml);
        toast('KML copiado. Na demonstração o download é bloqueado: cole em um arquivo .kml e importe no Google Earth.');
        return;
      }
      const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
      const a = document.createElement('a'); a.href = url; a.download = `${name.split(' ')[0]}.kml`; a.click(); URL.revokeObjectURL(url);
      toast('KML exportado. No Google Earth: Projetos → Novo projeto → Importar arquivo KML.');
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="row">
      <a className="btn ghost small" href={earthUrl(lat, lng, dist)} target="_blank" rel="noopener noreferrer">Abrir no Google Earth</a>
      <button type="button" className="btn ghost small" onClick={exportKml}>Exportar KML para o Earth</button>
      {kmlUrl && !DEMO && <button type="button" className="btn ghost small" title="Polilinha fechada em UTM SIRGAS 2000, para CAD" onClick={() => void downloadFile(kmlUrl.replace(/\/kml$/, '/dxf'), `${name.split(' ')[0]}.dxf`).catch((e) => toast(e.message, true))}>Exportar DXF</button>}
    </div>
  );
}

let gmapsPromise: Promise<any> | null = null;
function loadGoogleMaps() {
  if (!GMAPS_KEY) return Promise.reject(new Error('sem chave'));
  gmapsPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GMAPS_KEY)}&v=beta&libraries=maps3d&language=pt-BR&region=BR`;
    s.async = true;
    s.onload = () => resolve((window as any).google);
    s.onerror = () => reject(new Error('Não foi possível carregar o Google Maps'));
    document.head.appendChild(s);
  });
  return gmapsPromise;
}

/** Vista 3D fotorrealista com o perímetro (Google 3D Maps). Sem chave, explica como ativar e oferece o Google Earth. */
export function Google3DView({ lat, lng, areaM2, geometry, name, quiet }: { lat: number; lng: number; areaM2?: number | null; geometry?: any; name: string; /** portal público: sem chave ou com erro, não mostra nada */ quiet?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!GMAPS_KEY || !el.current) return;
    let cancelled = false;
    loadGoogleMaps().then(async (google) => {
      if (cancelled || !el.current) return;
      const { Map3DElement, Polygon3DElement } = await google.maps.importLibrary('maps3d');
      // A câmera mira um ponto com altitude absoluta: com 0 (nível do mar) ela fica rente ao chão no Planalto Central
      // (~800 m) e o perímetro some. Usa a altitude do terreno (Elevation API); sem ela, uma média do Centro-Oeste.
      let ground = 650;
      try {
        const { ElevationService } = await google.maps.importLibrary('elevation');
        const r = await new ElevationService().getElevationForLocations({ locations: [{ lat, lng }] });
        if (Number.isFinite(r.results?.[0]?.elevation)) ground = r.results[0].elevation;
      } catch { /* Elevation API fora das restrições da chave: segue com a média */ }
      if (cancelled || !el.current) return;
      const map = new Map3DElement({ center: { lat, lng, altitude: ground }, range: areaM2 ? Math.max(900, Math.sqrt(areaM2) * 3.4) : 2500, tilt: 55, heading: 20, mode: 'SATELLITE' });
      const rings: number[][][] = geometry?.type === 'Polygon' ? [geometry.coordinates[0]] : geometry?.type === 'MultiPolygon' ? geometry.coordinates.map((p: any) => p[0]) : [];
      for (const ring of rings) {
        const poly = new Polygon3DElement({ strokeColor: '#0a1a33', strokeWidth: 3, fillColor: 'rgba(248,184,23,0.35)', altitudeMode: 'CLAMP_TO_GROUND', drawsOccludedSegments: true });
        poly.outerCoordinates = ring.map(([x, y]) => ({ lat: y, lng: x }));
        map.append(poly);
      }
      map.style.cssText = 'display:block;width:100%;height:100%';
      el.current.replaceChildren(map);
    }).catch((e) => setErr(e.message));
    return () => { cancelled = true; };
  }, [lat, lng, areaM2, geometry]);

  if (!GMAPS_KEY || err) {
    if (quiet) return null;
    return (
      <div className="panel" style={{ background: 'var(--paper)' }}>
        <b>Vista 3D</b>
        <p className="small muted" style={{ margin: '0.3rem 0 0.6rem' }}>
          {err ?? `A vista 3D fotorrealista integrada usa o Google 3D Maps e precisa de uma chave da Google Maps Platform (VITE_GOOGLE_MAPS_API_KEY).${DEMO ? ' Na demonstração, scripts externos são bloqueados.' : ''}`} Enquanto isso, abra a área no Google Earth.
        </p>
        <a className="btn small gold" href={earthUrl(lat, lng, areaM2 ? Math.max(800, Math.sqrt(areaM2) * 4) : 2500)} target="_blank" rel="noopener noreferrer">Ver {name.split(' — ')[0]} no Google Earth</a>
      </div>
    );
  }
  return <div ref={el} style={{ height: 420, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)' }} aria-label="Vista 3D" />;
}
