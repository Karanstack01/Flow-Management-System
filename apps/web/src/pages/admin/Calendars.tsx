import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, FormField, Input, PageHeader, Select, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';

interface CalendarRow {
  id: string;
  name: string;
  timezone: string;
  shiftStart: string;
  shiftEnd: string;
  weeklyOff: number[];
  holidays: { date: string; name: string }[];
}
interface OptionSetRow {
  id: string;
  key: string;
  name: string;
  options: string[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ZONES = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];
/** Chrome lists legacy names (Asia/Calcutta) while the data uses current ones (Asia/Kolkata). */
const ALIASES: Record<string, string> = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires' };

/**
 * Zone options that always include the saved value. Without this the <select> silently showed the
 * first zone (Africa/Abidjan) for Asia/Kolkata in Chrome — and saving would have written it.
 */
function timezoneOptions(current: string): string[] {
  const zones = new Set(ZONES.map((z) => ALIASES[z] ?? z));
  if (current) zones.add(current);
  return [...zones].sort();
}

/** Replaces the legacy Holiday tab + shift/timezone cells, and dropdown source ranges. */
export default function CalendarsAdmin() {
  const qc = useQueryClient();
  const calendars = useQuery({ queryKey: ['calendars'], queryFn: () => api<{ items: CalendarRow[] }>('/admin/calendars').then((r) => r.items) });
  const sets = useQuery({ queryKey: ['option-sets'], queryFn: () => api<{ items: OptionSetRow[] }>('/admin/option-sets').then((r) => r.items) });
  const [adding, setAdding] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Calendars & lists" subtitle="Working hours and holidays drive every TAT and delay calculation." actions={<Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add calendar</Button>} />
      {!calendars.data ? <Spinner /> : calendars.data.map((c) => <CalendarEditor key={c.id} cal={c} onSaved={() => void qc.invalidateQueries({ queryKey: ['calendars'] })} />)}
      {adding && (
        <CalendarEditor
          cal={{ id: '', name: 'New calendar', timezone: ALIASES[Intl.DateTimeFormat().resolvedOptions().timeZone] ?? Intl.DateTimeFormat().resolvedOptions().timeZone, shiftStart: '09:00', shiftEnd: '18:00', weeklyOff: [7], holidays: [] }}
          onSaved={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['calendars'] });
          }}
        />
      )}
      <Card title="Option lists" bodyClassName="space-y-4">
        {!sets.data ? <Spinner /> : sets.data.map((s) => <OptionSetEditor key={s.id} set={s} onSaved={() => void qc.invalidateQueries({ queryKey: ['option-sets'] })} />)}
        <OptionSetEditor set={{ id: '', key: '', name: '', options: [] }} onSaved={() => void qc.invalidateQueries({ queryKey: ['option-sets'] })} />
      </Card>
    </div>
  );
}

function CalendarEditor({ cal, onSaved }: { cal: CalendarRow; onSaved: () => void }) {
  const [c, setC] = useState<CalendarRow>({
    ...cal,
    weeklyOff: Array.isArray(cal.weeklyOff) ? cal.weeklyOff : [7],
    holidays: Array.isArray(cal.holidays) ? cal.holidays : [],
  });
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const weeklyOff = Array.isArray(c.weeklyOff) ? c.weeklyOff : [7];
  const holidays = Array.isArray(c.holidays) ? c.holidays : [];

  async function save() {
    setBusy(true);
    try {
      const body = { name: c.name, config: { timezone: c.timezone, shiftStart: c.shiftStart, shiftEnd: c.shiftEnd, weeklyOff }, holidays };
      await api(c.id ? `/admin/calendars/${c.id}` : '/admin/calendars', { method: c.id ? 'PUT' : 'POST', body });
      toast.success('Calendar saved');
      onSaved();
    } catch (e) {
      const d = (e as { details?: Record<string, string> }).details;
      toast.error((e as Error).message, { description: d ? Object.values(d).join('; ') : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={c.name || 'Calendar'} actions={<Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={busy} onClick={() => void save()}>Save</Button>}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <FormField label="Name">
          <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </FormField>
        <FormField label="Timezone">
          <Select value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })}>
            {timezoneOptions(c.timezone).map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Shift start">
          <Input type="time" value={c.shiftStart} onChange={(e) => setC({ ...c, shiftStart: e.target.value })} />
        </FormField>
        <FormField label="Shift end">
          <Input type="time" value={c.shiftEnd} onChange={(e) => setC({ ...c, shiftEnd: e.target.value })} />
        </FormField>
      </div>
      <p className="label mt-4">Weekly off</p>
      <div className="flex flex-wrap gap-2">
        {DAYS.map((d, i) => (
          <label key={d} className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-sm">
            <input
              type="checkbox"
              checked={weeklyOff.includes(i + 1)}
              onChange={(e) => setC({ ...c, weeklyOff: e.target.checked ? [...weeklyOff, i + 1] : weeklyOff.filter((x) => x !== i + 1) })}
            />
            {d}
          </label>
        ))}
      </div>
      <p className="label mt-4">Holidays ({holidays.length})</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input type="date" className="w-auto" value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="Holiday date" />
        <Input className="w-56" placeholder="Holiday name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Holiday name" />
        <Button
          icon={<Plus className="size-4" />}
          disabled={!newDate || !newName || holidays.some((h) => h.date === newDate)}
          onClick={() => {
            setC({ ...c, holidays: [...holidays, { date: newDate, name: newName }].sort((a, b) => a.date.localeCompare(b.date)) });
            setNewDate('');
            setNewName('');
          }}
        >
          Add
        </Button>
      </div>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {holidays.map((h) => (
          <li key={h.date} className="flex items-center justify-between rounded border border-line px-2 py-1 text-sm">
            <span>
              <span className="tabular-nums text-muted">{h.date}</span> {h.name}
            </span>
            <Button size="sm" variant="ghost" aria-label={`Remove ${h.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => setC({ ...c, holidays: holidays.filter((x) => x.date !== h.date) })} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OptionSetEditor({ set, onSaved }: { set: OptionSetRow; onSaved: () => void }) {
  const [key, setKey] = useState(set.key || '');
  const [name, setName] = useState(set.name || '');
  const [text, setText] = useState((set.options ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api('/admin/option-sets', { method: 'PUT', body: { key, name, options: text.split('\n').map((x) => x.trim()).filter(Boolean) } });
      toast.success('List saved');
      if (!set.id) {
        setKey('');
        setName('');
        setText('');
      }
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border border-line p-3 md:grid-cols-[1fr_1fr_2fr_auto]">
      <FormField label="Key">
        <Input value={key} disabled={!!set.id} placeholder="cities" onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
      </FormField>
      <FormField label="Name">
        <Input value={name} placeholder="Cities" onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="Options (one per line)">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} />
      </FormField>
      <Button className="self-end" loading={busy} disabled={!key || !name} onClick={() => void save()}>
        {set.id ? 'Save' : 'Create'}
      </Button>
    </div>
  );
}
