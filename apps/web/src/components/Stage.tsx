import clsx from 'clsx';
import { Check, Circle, CircleDot, SkipForward } from 'lucide-react';
import type { StageDto, StageView } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Badge } from './ui';

export function CurrentStageBadge({ stages, defs, currentStageKey }: { stages: StageDto[]; defs: StageView[]; currentStageKey: string | null }) {
  if (!currentStageKey) return <Badge tone="success">Completed</Badge>;
  const def = defs.find((s) => s.key === currentStageKey);
  const state = stages.find((s) => s.stageKey === currentStageKey);
  return (
    <span className="inline-flex items-center gap-1">
      <Badge color={def?.color}>{def?.name ?? currentStageKey}</Badge>
      {state?.overdue && <Badge tone="danger">Overdue</Badge>}
    </span>
  );
}

/** Horizontal stepper with planned vs actual per stage (legacy planned/actual column pairs). */
export function StageTimeline({ stages, defs, zone, selected, onSelect }: { stages: StageDto[]; defs: StageView[]; zone?: string; selected?: string; onSelect?: (key: string) => void }) {
  return (
    <ol className="flex gap-2 overflow-x-auto pb-1">
      {defs.map((def) => {
        const s = stages.find((x) => x.stageKey === def.key);
        const status = s?.status ?? 'waiting';
        const late = status === 'done' && s?.plannedAt && s.actualAt && s.actualAt > s.plannedAt;
        const Icon = status === 'done' ? Check : status === 'active' ? CircleDot : status === 'skipped' ? SkipForward : Circle;
        return (
          <li key={def.key} className="min-w-44 flex-1">
            <button
              type="button"
              onClick={() => onSelect?.(def.key)}
              className={clsx(
                'w-full rounded-md border px-3 py-2 text-left transition-colors',
                selected === def.key ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-surface-2',
                status === 'skipped' && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="grid size-5 place-items-center rounded-full text-white" style={{ background: status === 'waiting' ? 'var(--color-line)' : def.color }}>
                  <Icon className="size-3" />
                </span>
                <span className="truncate">{def.name}</span>
              </div>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted">
                <dt>Plan</dt>
                <dd className={clsx(s?.overdue && 'font-medium text-danger')}>{fmtDateTime(s?.plannedAt, zone)}</dd>
                <dt>Actual</dt>
                <dd className={clsx(late ? 'text-warning' : status === 'done' && 'text-success')}>{status === 'skipped' ? 'Skipped' : fmtDateTime(s?.actualAt, zone)}</dd>
              </dl>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
