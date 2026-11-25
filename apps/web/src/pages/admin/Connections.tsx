import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleCheck, CircleX, Cloud, ExternalLink, KeyRound, Mail, MessageCircle, Send, Sheet, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, Button, ErrorNote, FormField, Input, PageHeader, Select, Spinner, Switch } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { fmtRelative } from '../../lib/format';

type Provider = 'cloudinary' | 'google' | 'microsoft' | 'redlava' | 'anthropic' | 'gsheets';

interface ConnectionView {
  provider: Provider;
  kind: 'storage' | 'email' | 'whatsapp' | 'ai' | 'sheets';
  label: string;
  saved: boolean;
  complete: boolean;
  isActive: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string | null>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedAt: string | null;
}

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  type?: 'text' | 'email' | 'url' | 'select';
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: ReactNode;
  required?: boolean;
  /** Only shown when this returns true for the current config. */
  when?: (config: Record<string, string>) => boolean;
}

const FIELDS: Record<Provider, FieldSpec[]> = {
  cloudinary: [
    { key: 'cloudName', label: 'Cloud name', required: true, placeholder: 'e.g. stackdrove', hint: 'Shown at the top of your Cloudinary console' },
    { key: 'apiKey', label: 'API key', required: true, placeholder: '123456789012345' },
    { key: 'apiSecret', label: 'API secret', secret: true, required: true },
    { key: 'folder', label: 'Folder', placeholder: 'fms', hint: 'Files go to <folder>/<organization>/<month>/' },
  ],
  google: [
    { key: 'email', label: 'Gmail / Google Workspace address', type: 'email', required: true, placeholder: 'ops@company.com' },
    { key: 'fromName', label: 'Sender name', placeholder: 'Company Operations' },
    {
      key: 'appPassword',
      label: 'App password',
      secret: true,
      required: true,
      placeholder: 'xxxx xxxx xxxx xxxx',
      hint: (
        <>
          Needs 2-Step Verification on the account. Create one at{' '}
          <a className="inline-flex items-center gap-0.5 text-info underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
            myaccount.google.com/apppasswords <ExternalLink className="size-3" />
          </a>
        </>
      ),
    },
  ],
  microsoft: [
    {
      key: 'mode',
      label: 'Sign-in method',
      type: 'select',
      options: [
        { value: 'graph', label: 'Microsoft 365 app (recommended)' },
        { value: 'smtp', label: 'Mailbox + app password (SMTP)' },
      ],
    },
    { key: 'email', label: 'Send as (mailbox)', type: 'email', required: true, placeholder: 'ops@company.com' },
    { key: 'fromName', label: 'Sender name', placeholder: 'Company Operations' },
    { key: 'tenantId', label: 'Directory (tenant) ID', required: true, placeholder: 'xxxxxxxx-xxxx-… or company.onmicrosoft.com', when: (c) => c.mode !== 'smtp' },
    { key: 'clientId', label: 'Application (client) ID', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', when: (c) => c.mode !== 'smtp' },
    {
      key: 'clientSecret',
      label: 'Client secret',
      secret: true,
      required: true,
      when: (c) => c.mode !== 'smtp',
      hint: 'Entra ID › App registrations: grant the Mail.Send application permission and admin consent.',
    },
    {
      key: 'appPassword',
      label: 'App password',
      secret: true,
      required: true,
      when: (c) => c.mode === 'smtp',
      hint: 'Microsoft is retiring password (basic) sign-in for Microsoft 365 SMTP. Prefer the app method where your tenant allows it.',
    },
  ],
  redlava: [
    { key: 'baseUrl', label: 'API endpoint', type: 'url', required: true, placeholder: 'https://… (from your RedLava dashboard)', hint: 'Messages are sent to <endpoint>/<phone number ID>/messages' },
    { key: 'phoneNumberId', label: 'Phone number ID', required: true, placeholder: 'Sender ID from RedLava' },
    { key: 'apiKey', label: 'API key / access token', secret: true, required: true },
    {
      key: 'authStyle',
      label: 'Send the key as',
      type: 'select',
      options: [
        { value: 'bearer', label: 'Authorization: Bearer <key>' },
        { value: 'header', label: 'Custom header' },
      ],
    },
    { key: 'headerName', label: 'Header name', placeholder: 'x-api-key', when: (c) => c.authStyle === 'header' },
    { key: 'defaultLanguage', label: 'Default template language', placeholder: 'en', hint: 'e.g. en, en_US, hi' },
    { key: 'defaultCountryCode', label: 'Default country code', placeholder: '91', hint: 'Added to 10-digit numbers saved without one' },
  ],
  anthropic: [
    {
      key: 'apiKey',
      label: 'Anthropic API key',
      secret: true,
      required: true,
      placeholder: 'sk-ant-…',
      hint: (
        <>
          Create one at{' '}
          <a className="inline-flex items-center gap-0.5 text-info underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
            platform.claude.com <ExternalLink className="size-3" />
          </a>
          . Usage is billed to that Anthropic account.
        </>
      ),
    },
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best answers (recommended)' },
        { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, lower cost' },
        { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, lowest cost' },
      ],
    },
    {
      key: 'effort',
      label: 'Effort',
      type: 'select',
      options: [
        { value: 'low', label: 'Low — quick summaries' },
        { value: 'medium', label: 'Medium (recommended)' },
        { value: 'high', label: 'High — deeper analysis, slower' },
      ],
    },
  ],
  gsheets: [
    { key: 'clientEmail', label: 'Service account email', type: 'email', required: true, placeholder: 'fms-export@project.iam.gserviceaccount.com', hint: 'client_email in the JSON key. Share each sheet you export to with this address (Editor).' },
    {
      key: 'privateKey',
      label: 'Private key',
      secret: true,
      required: true,
      placeholder: '-----BEGIN PRIVATE KEY----- …',
      hint: (
        <>
          private_key in the JSON key of a Google Cloud service account with the Sheets API enabled (
          <a className="inline-flex items-center gap-0.5 text-info underline" href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noreferrer">
            Service accounts <ExternalLink className="size-3" />
          </a>
          ).
        </>
      ),
    },
  ],
};

const DEFAULTS: Record<Provider, Record<string, string>> = {
  cloudinary: { folder: 'fms' },
  google: {},
  microsoft: { mode: 'graph' },
  redlava: { authStyle: 'bearer', headerName: 'x-api-key', defaultLanguage: 'en' },
  anthropic: { model: 'claude-opus-5-5', effort: 'medium' },
  gsheets: {},
};

function useConnections() {
  return useQuery({ queryKey: ['connections'], queryFn: () => api<{ items: ConnectionView[]; cloudinaryFiles: number }>('/admin/connections') });
}

export default function ConnectionsPage() {
  const { data, error, isLoading } = useConnections();
  const qc = useQueryClient();
  const byProvider = useMemo(() => Object.fromEntries((data?.items ?? []).map((c) => [c.provider, c])) as Record<Provider, ConnectionView>, [data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['connections'] });
  const activeEmail: Provider | 'none' = byProvider.google?.isActive ? 'google' : byProvider.microsoft?.isActive ? 'microsoft' : 'none';
  const [emailTab, setEmailTab] = useState<'google' | 'microsoft'>('google');
  useEffect(() => {
    if (activeEmail !== 'none') setEmailTab(activeEmail);
  }, [activeEmail]);

  async function switchEmail(to: Provider | 'none') {
    try {
      if (to === 'none') {
        if (activeEmail !== 'none') await api(`/admin/connections/${activeEmail}/deactivate`, { method: 'POST' });
        toast.success('Email now uses the server default');
      } else {
        await api(`/admin/connections/${to}/activate`, { method: 'POST' });
        toast.success(`Email now sends through ${to === 'google' ? 'Google' : 'Microsoft'}`);
      }
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
      if (to !== 'none') setEmailTab(to as 'google' | 'microsoft');
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Connections" subtitle="External services this organization’s flows use for attachments, email, WhatsApp and AI reports. Secrets are encrypted and never shown again." />
      <ErrorNote error={error} />
      {isLoading || !data ? (
        !error && <Spinner />
      ) : (
        <div className="space-y-8">
          {/* ---------------- storage */}
          <Section icon={<Cloud />} title="File storage" text="Where files attached to records are kept.">
            <ConnectionCard
              conn={byProvider.cloudinary}
              onChanged={refresh}
              toggle
              intro={
                <>
                  When on, new attachments are uploaded to your Cloudinary account as <b>private</b> files and are only served through this app after a permission check. Existing files stay where they are.
                  {data.cloudinaryFiles > 0 && <span className="mt-1 block">{data.cloudinaryFiles} file{data.cloudinaryFiles === 1 ? ' is' : 's are'} stored in Cloudinary.</span>}
                </>
              }
              offText="Off — attachments are stored on the server"
            />
          </Section>

          {/* ---------------- email */}
          <Section icon={<Mail />} title="Email" text="Sends hand-offs, reminders, digests and Message nodes.">
            <div className="card mb-3 flex flex-wrap items-center gap-3 p-4">
              <span className="text-sm font-medium">Send email with</span>
              <div role="radiogroup" aria-label="Email provider" className="inline-flex rounded-xl bg-surface-2 p-1">
                {(
                  [
                    ['google', 'Google'],
                    ['microsoft', 'Microsoft'],
                    ['none', 'Server default'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={activeEmail === value}
                    onClick={() => activeEmail !== value && void switchEmail(value)}
                    className={clsx('rounded-[9px] px-3.5 py-1.5 text-[13px] transition-all duration-200 ease-[var(--ease-apple)]', activeEmail === value ? 'bg-surface font-medium shadow-[0_1px_3px_rgb(0_0_0/0.1)]' : 'text-muted hover:text-fg')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted">Only one provider is used at a time. Set one up below, then switch to it.</span>
            </div>
            <div className="mb-3 inline-flex rounded-xl bg-surface-2 p-1" role="tablist" aria-label="Email provider settings">
              {(['google', 'microsoft'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={emailTab === p}
                  onClick={() => setEmailTab(p)}
                  className={clsx('inline-flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[13px] transition-all duration-200', emailTab === p ? 'bg-surface font-medium shadow-[0_1px_3px_rgb(0_0_0/0.1)]' : 'text-muted hover:text-fg')}
                >
                  {p === 'google' ? 'Google settings' : 'Microsoft settings'}
                  {byProvider[p]?.isActive && <span className="size-1.5 rounded-full bg-success" aria-label="in use" />}
                </button>
              ))}
            </div>
            <div key={emailTab} className="animate-page-in">
              <ConnectionCard conn={byProvider[emailTab]} onChanged={refresh} testKind="email" />
            </div>
          </Section>

          {/* ---------------- whatsapp */}
          <Section icon={<MessageCircle />} title="WhatsApp" text="Official WhatsApp Business messages from Message nodes and rules.">
            <ConnectionCard
              conn={byProvider.redlava}
              onChanged={refresh}
              toggle
              testKind="whatsapp"
              intro={
                <>
                  Official WhatsApp only lets a business <b>start</b> a conversation with a pre-approved template; free text is delivered only within 24 hours of the customer’s last message. Add the
                  template name in the Message node. Requests use the WhatsApp Cloud API message format — confirm the endpoint and key format with RedLava, then use <b>Send test</b>.
                </>
              }
              offText="Off — WhatsApp uses the server default (if configured)"
            />
          </Section>

          {/* ---------------- AI */}
          <Section icon={<Sparkles />} title="AI" text="Writes the AI reports set up in each flow’s settings.">
            <ConnectionCard
              conn={byProvider.anthropic}
              onChanged={refresh}
              toggle
              intro={
                <>
                  AI reports send the <b>fields you choose</b> of the matching records (at most 200 per run) to Anthropic’s Claude with your prompt, and email the answer. Use <b>Test connection</b> to check the key.
                </>
              }
              offText="Off — AI reports are not sent"
            />
          </Section>

          {/* ---------------- Google Sheets */}
          <Section icon={<Sheet />} title="Google Sheets" text="Lets people export filtered records into a Google Sheet tab.">
            <ConnectionCard
              conn={byProvider.gsheets}
              onChanged={refresh}
              toggle
              intro={<>Uses a Google <b>service account</b>: share the target spreadsheet with its email as Editor, then use <b>Export › Google Sheet</b> on a records list. The tab is replaced on each export. <b>Test connection</b> checks the sign-in.</>}
              offText="Off — export to CSV only"
            />
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-fg [&>svg]:size-[18px] [&>svg]:stroke-[1.75]">{icon}</span>
        <div>
          <h2 className="text-[17px] font-semibold">{title}</h2>
          <p className="text-[13px] text-muted">{text}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function StatusPill({ conn }: { conn: ConnectionView }) {
  if (conn.isActive) return <Badge tone="success">In use</Badge>;
  if (conn.complete) return <Badge>Set up · off</Badge>;
  return <Badge tone="warning">Not set up</Badge>;
}

function ConnectionCard({ conn, onChanged, toggle, intro, offText, testKind }: { conn: ConnectionView; onChanged: () => void; toggle?: boolean; intro?: ReactNode; offText?: string; testKind?: 'email' | 'whatsapp' }) {
  const provider = conn.provider;
  const initial = () => ({ ...DEFAULTS[provider], ...Object.fromEntries(Object.entries(conn.config).map(([k, v]) => [k, v == null ? '' : String(v)])) });
  const [config, setConfig] = useState<Record<string, string>>(initial);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'toggle' | 'remove' | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testTemplate, setTestTemplate] = useState('');
  useEffect(() => {
    setConfig(initial());
    setSecrets({});
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the server copy changes
  }, [conn.updatedAt, provider]);

  const fields = FIELDS[provider].filter((f) => !f.when || f.when(config));
  const dirty = JSON.stringify(config) !== JSON.stringify(initial()) || Object.values(secrets).some((v) => v.trim());

  async function save() {
    setBusy('save');
    setErrors({});
    try {
      const cleanConfig = Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== ''));
      await api(`/admin/connections/${provider}`, { method: 'PUT', body: { config: cleanConfig, secrets } });
      toast.success(`${conn.label} settings saved`);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.details) setErrors(Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k.replace(/^(config|secrets)\./, ''), v])));
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(on: boolean) {
    setBusy('toggle');
    try {
      await api(`/admin/connections/${provider}/${on ? 'activate' : 'deactivate'}`, { method: 'POST' });
      toast.success(on ? `${conn.label} switched on` : `${conn.label} switched off`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    try {
      const r = await api<{ ok: boolean; message: string }>(`/admin/connections/${provider}/test`, { method: 'POST', body: { to: testTo || undefined, template: testTemplate || undefined } });
      if (r.ok) toast.success('Connection works', { description: r.message });
      else toast.error('Test failed', { description: r.message });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message, { description: e instanceof ApiError && e.details ? Object.values(e.details).join('; ') : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the ${conn.label} connection and its saved credentials?`)) return;
    setBusy('remove');
    try {
      await api(`/admin/connections/${provider}`, { method: 'DELETE' });
      toast.success(`${conn.label} removed`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line/80 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 font-semibold">
            {conn.label} <StatusPill conn={conn} />
          </h3>
          {toggle && <p className="mt-0.5 text-xs text-muted">{conn.isActive ? 'On — used by every flow in this organization' : offText}</p>}
        </div>
        {toggle && <Switch checked={conn.isActive} label={`Use ${conn.label}`} disabled={!conn.complete || busy !== null || dirty} onChange={(v) => void setActive(v)} />}
      </header>

      <div className="space-y-4 p-5">
        {intro && <p className="rounded-xl bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-muted">{intro}</p>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {fields.map((f) => {
            const masked = f.secret ? conn.secrets[f.key] : null;
            return (
              <FormField key={f.key} label={f.label} required={f.required} error={errors[f.key]} hint={typeof f.hint === 'string' ? f.hint : undefined}>
                {f.type === 'select' ? (
                  <Select value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
                    {f.options!.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.secret ? (
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                    <Input
                      type="password"
                      className="pl-9"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={secrets[f.key] ?? ''}
                      placeholder={masked ? `Saved ${masked} — leave blank to keep` : (f.placeholder ?? 'Paste here')}
                      onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                    />
                  </div>
                ) : (
                  <Input type={f.type ?? 'text'} value={config[f.key] ?? ''} placeholder={f.placeholder} spellCheck={false} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                )}
                {typeof f.hint !== 'string' && f.hint && <span className="mt-1 block text-xs text-muted">{f.hint}</span>}
              </FormField>
            );
          })}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="size-3.5" /> Secrets are encrypted at rest (AES-256-GCM) and are never sent back to the browser.
        </p>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line/80 bg-surface-2/40 px-5 py-3.5">
        {conn.saved && conn.lastTestAt ? (
          <span className={clsx('flex min-w-0 flex-1 items-center gap-1.5 text-xs', conn.lastTestOk ? 'text-success' : 'text-danger')} title={conn.lastTestMessage ?? ''}>
            {conn.lastTestOk ? <CircleCheck className="size-4 shrink-0" /> : <CircleX className="size-4 shrink-0" />}
            <span className="truncate">
              {conn.lastTestOk ? 'Test passed' : 'Test failed'} {fmtRelative(conn.lastTestAt)} — {conn.lastTestMessage}
            </span>
          </span>
        ) : (
          <span className="flex-1 text-xs text-muted">{conn.saved ? 'Not tested yet' : 'Fill in the details and save'}</span>
        )}
        {conn.complete && testKind && (
          <Input
            className="h-8 w-56 text-[13px]"
            type={testKind === 'email' ? 'email' : 'tel'}
            placeholder={testKind === 'email' ? 'Send test to email' : 'Send test to number'}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            aria-label="Test recipient"
          />
        )}
        {conn.complete && testKind === 'whatsapp' && <Input className="h-8 w-48 text-[13px]" placeholder="Approved template (optional)" value={testTemplate} onChange={(e) => setTestTemplate(e.target.value.trim())} aria-label="Template name" />}
        {conn.complete && (
          <Button size="sm" icon={<Send className="size-3.5" />} loading={busy === 'test'} disabled={busy !== null || dirty} onClick={() => void test()} title={dirty ? 'Save first' : undefined}>
            {testKind ? 'Send test' : 'Test connection'}
          </Button>
        )}
        {conn.saved && <Button size="sm" variant="ghost" aria-label={`Remove ${conn.label}`} title="Remove" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()} />}
        <Button size="sm" variant="primary" loading={busy === 'save'} disabled={!dirty || busy !== null} onClick={() => void save()}>
          Save
        </Button>
      </footer>
    </article>
  );
}
