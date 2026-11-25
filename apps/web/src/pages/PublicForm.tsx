import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { staleDependents, type FieldValue } from '@fms/core';
import { changeWithDependents, FieldInput, fieldDefaults } from '../components/FieldInput';
import { StackDroveLogo } from '../components/StackDroveLogo';
import { StageIntro } from '../components/StageIntro';
import { Button, ErrorNote, FormField, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { PublicFormView, RecordData } from '../lib/types';

/**
 * Public intake form (Stage › Public Form Access): no sign-in. Shows the fields everyone may fill
 * in, then the flow's thank-you message.
 */
export default function PublicForm() {
  const { token = '' } = useParams();
  const { data: form, error, isLoading } = useQuery({ queryKey: ['public-form', token], queryFn: () => api<PublicFormView>(`/public/forms/${token}`), retry: false, staleTime: 5 * 60_000 });

  return (
    <div className="min-h-full bg-bg px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex justify-center">
          <StackDroveLogo variant="dark" className="h-7 dark:hidden" />
          <StackDroveLogo className="hidden h-7 dark:flex" />
        </div>
        {isLoading ? (
          <Spinner label="Opening form…" />
        ) : error || !form ? (
          <div className="card p-8 text-center">
            <h1 className="text-xl font-semibold">This form is not available</h1>
            <p className="mt-2 text-sm text-muted">The link may be wrong, or the form is no longer accepting responses.</p>
          </div>
        ) : (
          <Form key={token} token={token} form={form} />
        )}
      </div>
    </div>
  );
}

function Form({ token, form }: { token: string; form: PublicFormView }) {
  const headerFields = form.fields.filter((f) => !f.lineItem);
  const itemFields = form.fields.filter((f) => f.lineItem);
  const fresh = () => ({ header: fieldDefaults(headerFields, form.timezone), items: [fieldDefaults(itemFields, form.timezone)] });
  const [state, setState] = useState(fresh);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ numbers: number[]; thankYou: string | null } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setSubmitError(null);
    try {
      const r = await api<{ numbers: number[]; thankYou: string | null }>(`/public/forms/${token}`, { method: 'POST', body: { data: state.header, ...(itemFields.length ? { items: state.items } : {}) } });
      setDone(r);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (err instanceof ApiError && err.details) setErrors(err.details);
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card animate-pop-in p-8 text-center">
        <span className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-7" />
        </span>
        <h1 className="text-xl font-semibold">{done.thankYou ? 'Thank you!' : 'Response submitted'}</h1>
        <p className="mx-auto mt-2 max-w-md whitespace-pre-wrap text-[15px] text-muted">{done.thankYou ?? 'Your response has been recorded. You can close this page.'}</p>
        <p className="mt-3 text-xs text-muted">Reference: {done.numbers.map((n) => `#${n}`).join(', ')}</p>
        <Button className="mt-6" onClick={() => (setDone(null), setState(fresh()))}>
          Submit another response
        </Button>
      </div>
    );
  }

  // Changing a dropdown clears dependent dropdowns below it that no longer fit (header and rows).
  const setItem = (i: number, key: string, v: FieldValue) => setState((s) => ({ ...s, items: s.items.map((it, j) => (j === i ? changeWithDependents(form.fields, it, key, v, { context: s.header }) : it)) }));
  const setHead = (key: string, v: FieldValue) =>
    setState((s) => {
      const header = changeWithDependents(form.fields, s.header, key, v);
      return { header, items: s.items.map((it) => ({ ...it, ...staleDependents(itemFields, { ...header, ...it }, [key]) })) };
    });
  return (
    <form onSubmit={submit} className="card space-y-5 p-6 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">{form.name}</h1>
        <p className="mt-1 text-[15px] text-muted">{form.stage.name}</p>
        {form.description && <p className="mt-2 text-sm text-muted">{form.description}</p>}
      </header>
      <StageIntro description={form.stage.description} video={form.stage.video} />
      <ErrorNote error={submitError} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {headerFields.map((f) => (
          <FormField key={f.key} label={f.label} required={f.required} error={errors[f.key]} hint={f.helpText} className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
            <FieldInput field={f} value={state.header[f.key]} onChange={(v) => setHead(f.key, v)} zone={form.timezone} data={state.header} invalid={!!errors[f.key]} />
          </FormField>
        ))}
      </div>
      {itemFields.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold">Items</p>
          {errors.items && <p className="text-sm text-danger">{errors.items}</p>}
          {state.items.map((it: RecordData, i) => (
            <div key={i} className="rounded-2xl border border-line p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Item {i + 1}</span>
                <span className="flex gap-1">
                  <Button type="button" size="sm" variant="ghost" aria-label="Duplicate item" icon={<Copy className="size-4" />} onClick={() => setState((s) => ({ ...s, items: [...s.items.slice(0, i + 1), { ...it }, ...s.items.slice(i + 1)] }))} />
                  <Button type="button" size="sm" variant="ghost" aria-label="Remove item" disabled={state.items.length === 1} icon={<Trash2 className="size-4" />} onClick={() => setState((s) => ({ ...s, items: s.items.filter((_, j) => j !== i) }))} />
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {itemFields.map((f) => (
                  <FormField key={f.key} label={f.label} required={f.required} error={errors[`items.${i}.${f.key}`]}>
                    <FieldInput field={f} value={it[f.key]} onChange={(v) => setItem(i, f.key, v)} zone={form.timezone} data={{ ...state.header, ...it }} invalid={!!errors[`items.${i}.${f.key}`]} />
                  </FormField>
                ))}
              </div>
            </div>
          ))}
          <Button type="button" size="sm" icon={<Plus className="size-4" />} onClick={() => setState((s) => ({ ...s, items: [...s.items, fieldDefaults(itemFields, form.timezone)] }))}>
            Add item
          </Button>
        </div>
      )}
      <div className="flex justify-end border-t border-line pt-5">
        <Button type="submit" variant="primary" loading={busy}>
          Submit
        </Button>
      </div>
    </form>
  );
}
