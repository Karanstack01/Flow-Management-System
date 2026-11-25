/**
 * Small SVG charts for the dashboard. Colours come from the `.viz` roles in index.css
 * (validated palette: series-1/2 categorical, status good/critical reserved for on-time/late
 * and always paired with an icon + label). Every chart has hover detail and a text alternative.
 */
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNumber } from '../lib/format';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (pow / 2)) * (pow / 2);
};

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// ------------------------------------------------------------------ throughput (2-series line)
const SERIES = [
  { key: 'created', label: 'Created', color: 'var(--series-1)' },
  { key: 'completed', label: 'Completed', color: 'var(--series-2)' },
] as const;

export function TrendChart({ data }: { data: { date: string; created: number; completed: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { l: 32, r: 104, t: 12, b: 26 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => [d.created, d.completed])));
  const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const path = (k: 'created' | 'completed') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ');
  const area = (k: 'created' | 'completed') => `${path(k)} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const last = data[data.length - 1];
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 70))));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };

  return (
    <div className="viz">
      {/* Legend: identity is never colour-alone. */}
      <div className="mb-2 flex flex-wrap gap-4 text-[13px]">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-muted">
            <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={`Records created and completed per day, last ${data.length} days`}>
          <defs>
            {SERIES.map((s) => (
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={pad.l + innerW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={t === 0 ? 1 : 0.75} strokeDasharray={t === 0 ? undefined : '2 4'} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--axis)" className="tabular-nums">
                {Math.round(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % every === 0 || i === data.length - 1 ? (
              <text key={d.date} x={x(i)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--axis)">
                {dayLabel(d.date)}
              </text>
            ) : null,
          )}
          {SERIES.map((s, si) => (
            <g key={s.key}>
              {/* One soft fill (the first series): two overlapping fills blend into a muddy grey. */}
              {si === 0 && <path d={area(s.key)} fill={`url(#fill-${s.key})`} />}
              <path d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {/* Direct labels at the line ends. */}
          {last &&
            (() => {
              // Keep the two end labels at least 16px apart (equal values would otherwise overprint).
              const ys = SERIES.map((s) => y(last[s.key]));
              if (Math.abs(ys[0]! - ys[1]!) < 16) {
                const mid = (ys[0]! + ys[1]!) / 2;
                const createdOnTop = last.created >= last.completed;
                ys[0] = createdOnTop ? mid - 8 : mid + 8;
                ys[1] = createdOnTop ? mid + 8 : mid - 8;
              }
              return SERIES.map((s, si) => (
                <text key={s.key} x={x(data.length - 1) + 10} y={Math.min(pad.t + innerH, Math.max(pad.t + 6, ys[si]!))} dy="0.32em" fontSize={12} fill="var(--color-fg)">
                  <tspan fontWeight={600}>{last[s.key]}</tspan>
                  <tspan fill="var(--color-muted)"> {s.label.toLowerCase()}</tspan>
                </text>
              ));
            })()}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--axis)" strokeWidth={1} strokeDasharray="3 3" />
              {SERIES.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(data[hover]![s.key])} r={4.5} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} />
              ))}
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-[var(--shadow-float)] backdrop-blur"
            style={{ left: Math.min(x(hover) + 12, width - 160), top: 8 }}
          >
            <p className="mb-1 font-medium">{new Date(`${data[hover].date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-2">
                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                <span className="text-muted">{s.label}</span>
                <span className="ml-auto font-semibold tabular-nums">{data[hover]![s.key]}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      {/* Table view for screen readers. */}
      <table className="sr-only">
        <caption>Records created and completed per day</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Created</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.created}</td>
              <td>{d.completed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ on-time performance (hero + status meter)
export function OnTimeMeter({ onTime, late, avgLateHours }: { onTime: number; late: number; avgLateHours: number | null }) {
  const total = onTime + late;
  const pct = total ? Math.round((onTime / total) * 100) : null;
  return (
    <div className="viz flex h-full flex-col">
      <p className="text-[44px] font-semibold leading-none tracking-tight">{pct === null ? '—' : `${pct}%`}</p>
      <p className="mt-1.5 text-[13px] text-muted">{total ? `of ${fmtNumber(total)} stages finished on time` : 'No timed stages finished yet'}</p>
      {total > 0 && (
        <>
          <div className="mt-5 flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`${onTime} on time, ${late} late`}>
            <div className="h-full rounded-l-full transition-[width] duration-700 ease-[var(--ease-apple)]" style={{ width: `${(onTime / total) * 100}%`, background: 'var(--status-good)' }} />
            {late > 0 && <div className="h-full rounded-r-full transition-[width] duration-700 ease-[var(--ease-apple)]" style={{ width: `${(late / total) * 100}%`, background: 'var(--status-critical)' }} />}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            <span className="flex items-center gap-1.5">
              <CircleCheck className="size-4" style={{ color: 'var(--status-good)' }} />
              <span className="font-medium tabular-nums">{fmtNumber(onTime)}</span> <span className="text-muted">on time</span>
            </span>
            <span className="flex items-center gap-1.5">
              <TriangleAlert className="size-4" style={{ color: 'var(--status-critical)' }} />
              <span className="font-medium tabular-nums">{fmtNumber(late)}</span> <span className="text-muted">late</span>
            </span>
          </div>
          {avgLateHours !== null && late > 0 && <p className="mt-auto pt-4 text-xs text-muted">Late ones finished {avgLateHours.toFixed(1)} h after plan on average (clock hours).</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ open work by team (single-series bars)
export function TeamBars({ teams }: { teams: { group: string; active: number; overdue: number }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = useMemo(() => Math.max(1, ...teams.map((t) => t.active)), [teams]);
  if (!teams.length) return <p className="py-8 text-center text-sm text-muted">No open work right now.</p>;
  return (
    <ul className="viz space-y-3" aria-label="Open stages by team">
      {teams.map((t) => (
        <li key={t.group} onMouseEnter={() => setHover(t.group)} onMouseLeave={() => setHover(null)} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
            <span className="truncate font-medium">{t.group}</span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
              {t.overdue > 0 && (
                <span className="flex items-center gap-0.5 text-xs font-medium" style={{ color: 'var(--status-critical)' }}>
                  <TriangleAlert className="size-3" /> {t.overdue} late
                </span>
              )}
              <span className="font-semibold">{t.active}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div
              className="h-full rounded-full transition-[width,opacity] duration-500 ease-[var(--ease-apple)]"
              style={{ width: `${Math.max(3, (t.active / max) * 100)}%`, background: 'var(--series-1)', opacity: hover && hover !== t.group ? 0.45 : 1 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
