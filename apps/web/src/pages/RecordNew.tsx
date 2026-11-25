import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { staleDependents, type FieldValue } from '@fms/core';
import { changeWithDependents, FieldInput, fieldDefaults } from '../components/FieldInput';
import { StageIntro } from '../components/StageIntro';
import { Button, Card, ErrorNote, FormField, PageHeader, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useRecordsInvalidation, useWorkflow } from '../lib/queries';
import type { FieldView, RecordData, RecordDto } from '../lib/types';

/**
 * Intake form — replaces legacy "submit form" (single record) and "Form" (header +
 * repeating line items, one record per item sharing a submission).
 */
export default function RecordNew() {
  const { wf: wfKey = '' } = useParams();
  const { data: wf, error: loadError } = useWorkflow(wfKey);
  const navigate = useNavigate();
  const invalidate = useRecordsInvalidation(wfKey);
  const [header, setHeader] = useState<RecordData>({});
  const [items, setItems] = useState<RecordData[]>([{}]);
  const [seeded, setSeeded] = useState(false);
  // Pre-fill each field's default value once the definition has loaded.
  if (wf && !seeded) {
    const fields = wf.fields.filter((f) => f.stageKey === wf.stages[0]!.key && f.canEdit);
    setHeader(fieldDefaults(fields.filter((f) => !f.lineItem), wf.timezone));
    setItems([fieldDefaults(fields.filter((f) => f.lineItem), wf.timezone)]);
    setSeeded(true);
  }
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (loadError) return <ErrorNote error={loadError} />;
  if (!wf) return <Spinner />;

  const intake = wf.stages[0]!.key;
  const intakeFields = wf.fields.filter((f) => f.stageKey === intake);
  const headerFields = intakeFields.filter((f) => !f.lineItem);
  const itemFields = intakeFields.filter((f) => f.lineItem);
  const editableKeys = (fields: FieldView[]) => fields.filter((f) => f.canEdit && f.type !== 'computed' && f.type !== 'user-email').map((f) => f.key);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setSubmitError(null);
    const pick = (d: RecordData, keys: string[]) => Object.fromEntries(keys.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
    try {
      const body = { data: pick(header, editableKeys(headerFields)), ...(itemFields.length ? { items: items.map((it) => pick(it, editableKeys(itemFields))) } : {}) };
      const res = await api<{ records?: RecordDto[]; items?: RecordDto[]; id?: string; number?: number }>(`/workflows/${wf!.key}/records`, { method: 'POST', body });
      invalidate();
      const recs: RecordDto[] = Array.isArray(res?.records)
        ? res.records
        : Array.isArray(res?.items)
          ? res.items
          : Array.isArray(res)
            ? res
            : res && typeof res === 'object' && 'id' in res
              ? [res as unknown as RecordDto]
              : [];
      const count = recs.length;
      const first = recs[0];
      const created = count === 1 && first ? `Record #${first.number} created` : `${count} records created`;
      // Stage › Thank you message, when the flow has one.
      const thanks = wf!.stages[0]?.thankYou;
      if (thanks) toast.success(thanks, { description: created, duration: 8000 });
      else toast.success(created);
      navigate(count === 1 && first ? `/w/${wf!.key}/records/${first.id}` : `/w/${wf!.key}`);
    } catch (err) {
      if (err instanceof ApiError && err.details) setErrors(err.details);
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  // Changing a dropdown clears dependent dropdowns below it that no longer fit — in the header and,
  // for a header parent, in every repeating row.
  const setItem = (i: number, key: string, v: FieldValue) => setItems((arr) => arr.map((it, j) => (j === i ? changeWithDependents(intakeFields, it, key, v, { context: header }) : it)));
  const setHead = (key: string, v: FieldValue) => {
    const next = changeWithDependents(intakeFields, header, key, v);
    setHeader(next);
    if (itemFields.some((f) => f.type === 'dependent-select')) setItems((arr) => arr.map((it) => ({ ...it, ...staleDependents(itemFields, { ...next, ...it }, [key]) })));
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title={`New ${wf.name} record`}
        subtitle={wf.description}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Submit
            </Button>
          </>
        }
      />
      <ErrorNote error={submitError} />
      {(wf.stages[0]?.description || wf.stages[0]?.video) && (
        <Card>
          <StageIntro description={wf.stages[0]!.description} video={wf.stages[0]!.video} />
        </Card>
      )}
      <Card title="Details">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {headerFields.map((f) => (
            <FormField key={f.key} label={f.label} required={f.required} error={errors[f.key]} hint={f.helpText} className={f.type === 'textarea' ? 'md:col-span-2' : undefined}>
              <FieldInput field={f} value={header[f.key]} onChange={(v) => setHead(f.key, v)} disabled={!f.canEdit} zone={wf.timezone} data={header} invalid={!!errors[f.key]} />
            </FormField>
          ))}
        </div>
      </Card>

      {itemFields.length > 0 && (
        <Card
          title={`Items (${items.length})`}
          actions={
            <Button type="button" size="sm" icon={<Plus className="size-4" />} onClick={() => setItems((a) => [...a, fieldDefaults(itemFields.filter((f) => f.canEdit), wf.timezone)])}>
              Add item
            </Button>
          }
          bodyClassName="p-0"
        >
          {errors.items && <p className="px-4 pt-3 text-sm text-danger">{errors.items}</p>}
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  {itemFields.map((f) => (
                    <th key={f.key} style={{ minWidth: f.width ?? 160 }}>
                      {f.label}
                      {f.required && <span className="text-danger"> *</span>}
                    </th>
                  ))}
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td className="pt-4 text-muted tabular-nums">{i + 1}</td>
                    {itemFields.map((f) => {
                      const err = errors[`items.${i}.${f.key}`];
                      return (
                        <td key={f.key}>
                          <FieldInput field={f} value={it[f.key]} onChange={(v) => setItem(i, f.key, v)} disabled={!f.canEdit} zone={wf.timezone} data={{ ...header, ...it }} invalid={!!err} />
                          {err && <span className="mt-1 block text-xs text-danger">{err}</span>}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap">
                      <Button type="button" variant="ghost" size="sm" aria-label="Duplicate item" icon={<Copy className="size-4" />} onClick={() => setItems((a) => [...a.slice(0, i + 1), { ...it }, ...a.slice(i + 1)])} />
                      <Button type="button" variant="ghost" size="sm" aria-label="Remove item" disabled={items.length === 1} icon={<Trash2 className="size-4" />} onClick={() => setItems((a) => a.filter((_, j) => j !== i))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </form>
  );
}
