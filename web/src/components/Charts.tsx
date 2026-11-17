import { useState } from 'react';

/**
 * Gráficos de série única (um matiz, sem legenda). Rótulos e valores em tinta de texto, nunca na cor da série.
 * Barras finas com extremidade arredondada de 4px ancorada na base, 2px de respiro entre barras, tooltip ao passar o mouse.
 */
export function ColumnChart({ data, height = 180, valueLabel, color = '#16294a' }: { data: { label: string; value: number; detail?: string }[]; height?: number; valueLabel: string; color?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <p className="muted small">Sem dados no período.</p>;
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = Math.ceil(max / 5) * 5 || 5;
  const W = 600, H = height, padL = 28, padB = 22, plotH = H - padB - 6, plotW = W - padL;
  const step = plotW / data.length;
  const bw = Math.max(4, Math.min(28, step - 2));
  const ticks = [0, nice / 2, nice];
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${valueLabel}: ${data.map((d) => `${d.label} ${d.value}`).join(', ')}`}>
        {ticks.map((t) => {
          const y = 6 + plotH - (t / nice) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W} y1={y} y2={y} stroke="#e9ecf2" strokeWidth={1} />
              <text x={padL - 6} y={y + 4} fontSize="11" textAnchor="end" fill="#5a6a84">{t}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / nice) * plotH;
          const x = padL + i * step + (step - bw) / 2;
          const y = 6 + plotH - h;
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * step} y={0} width={step} height={H} fill="transparent" />
              {h > 0 && <path d={`M${x},${y + plotH - (y - 6) + 0} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${6 + plotH} Z`} fill={hover === i ? '#d99c00' : color} />}
              {(i % Math.ceil(data.length / 7) === 0 || i === data.length - 1) && (
                <text x={x + bw / 2} y={H - 6} fontSize="11" textAnchor="middle" fill="#5a6a84">{d.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="tip" style={{ left: `${((padL + hover * step + step / 2) / W) * 100}%`, top: `${((6 + plotH - (data[hover].value / nice) * plotH) / H) * 100}%` }}>
          {data[hover].label}: <b>{data[hover].value}</b> {valueLabel}{data[hover].detail ? ` · ${data[hover].detail}` : ''}
        </div>
      )}
    </div>
  );
}

export function HBars({ data, format = (v: number) => String(v) }: { data: { label: string; value: number }[]; format?: (v: number) => string }) {
  if (!data.length) return <p className="muted small">Sem dados no período.</p>;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="hbar" role="list">
      {data.map((d) => (
        <div className="hbar-row" key={d.label} role="listitem" title={`${d.label}: ${format(d.value)}`}>
          <span className="lbl">{d.label}</span>
          <span className="track"><span className="fill" style={{ width: `${(d.value / max) * 100}%`, display: 'block' }} /></span>
          <span className="val num">{format(d.value)}</span>
        </div>
      ))}
    </div>
  );
}
