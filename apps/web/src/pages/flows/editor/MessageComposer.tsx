/**
 * Building blocks for composing Message nodes: a tag picker over the form fields, inputs that
 * insert tags at the cursor, a small rich-text editor (with an HTML mode) and a live preview.
 */
import clsx from 'clsx';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Braces,
  Code2,
  Eye,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Mail,
  MessageCircle,
  Search,
  Type,
  Underline,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { escapeHtml, isHtmlBody, renderTemplate, sanitizeEmailHtml, type FieldDef, type MessageNodeData, type RecordData, type WorkflowDef } from '@fms/core';
import { Input, Textarea } from '../../../components/ui';
import { sanitizeHtml } from '../../../lib/sanitize';

// ------------------------------------------------------------------ tags
const SYSTEM_TAGS = [
  { key: 'record_number', label: 'Record number' },
  { key: 'record_title', label: 'Record title' },
  { key: 'workflow_name', label: 'Flow name' },
  { key: 'current_stage', label: 'Current stage' },
  { key: 'link', label: 'Link to the record' },
];

/** Fields grouped by stage, then system values. */
function tagGroups(def: WorkflowDef) {
  return [
    ...def.stages.map((s) => ({ title: s.name, items: def.fields.filter((f) => f.stageKey === s.key && f.type !== 'file').map((f) => ({ key: f.key, label: f.label, type: f.type as string })) })),
    { title: 'Record', items: SYSTEM_TAGS.map((t) => ({ ...t, type: 'system' })) },
  ].filter((g) => g.items.length);
}

export function TagPicker({ def, onPick, filter, compact }: { def: WorkflowDef; onPick: (token: string) => void; filter?: (f: { key: string; type: string }) => boolean; compact?: boolean }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => !panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [pos]);
  const groups = tagGroups(def)
    .map((g) => ({ ...g, items: g.items.filter((i) => (!filter || filter(i)) && (!q || `${i.label} ${i.key}`.toLowerCase().includes(q.toLowerCase()))) }))
    .filter((g) => g.items.length);
  return (
    <>
      <button
        ref={btn}
        type="button"
        // Keep focus (and the caret) in the field being edited.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (pos) return setPos(null);
          const r = btn.current!.getBoundingClientRect();
          setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 360), left: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)) });
        }}
        title="Insert a form field"
        aria-haspopup="listbox"
        aria-expanded={!!pos}
        className={clsx('inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-surface font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg', compact ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs')}
      >
        <Braces className="size-3.5" /> Tags
      </button>
      {pos &&
        createPortal(
          <div ref={panel} role="listbox" className="fixed z-[70] w-[260px] animate-pop-in overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-[var(--shadow-float)]" style={pos}>
            <div className="relative border-b border-line p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" className="h-8 w-full rounded-lg bg-surface-2 pl-7 pr-2 text-xs outline-none" />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {groups.length === 0 && <p className="p-3 text-xs text-muted">No matching fields</p>}
              {groups.map((g) => (
                <div key={g.title}>
                  <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{g.title}</p>
                  {g.items.map((i) => (
                    <button
                      key={i.key}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onPick(`{{${i.key}}}`);
                        setPos(null);
                        setQ('');
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate">{i.label}</span>
                      <code className="shrink-0 text-[10px] text-muted">{`{{${i.key}}}`}</code>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Text input / textarea with a Tags button that inserts at the cursor. */
export function TokenInput({
  value,
  onChange,
  def,
  placeholder,
  multiline,
  filter,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  def: WorkflowDef;
  placeholder?: string;
  multiline?: boolean;
  filter?: (f: { key: string; type: string }) => boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });
  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    caret.current = start + token.length;
    el?.focus();
  };
  return (
    <div className={clsx('relative', className)}>
      {multiline ? (
        <Textarea ref={ref} className="min-h-24 pr-20" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input ref={ref} className="pr-20" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      <span className={clsx('absolute right-1.5', multiline ? 'top-1.5' : 'top-1/2 -translate-y-1/2')}>
        <TagPicker def={def} onPick={insert} filter={filter} compact />
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ rich text
// Sanitised before it touches the live DOM: bodies may come from the Rules page or a template.
const toEditorHtml = (v: string) => (isHtmlBody(v) ? sanitizeHtml(v) : escapeHtml(v).replace(/\n/g, '<br>'));

const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New'];

export function RichTextEditor({
  value,
  onChange,
  def,
  minHeight = 180,
  extended,
  placeholder = 'Type your message here…',
}: {
  value: string;
  onChange: (html: string) => void;
  def: WorkflowDef;
  minHeight?: number;
  /** Document toolbar: H1–H4, font family, text and highlight colour. */
  extended?: boolean;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<'visual' | 'html'>('visual');
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  // Only push external changes into the DOM (re-setting innerHTML on every keystroke loses the caret).
  useEffect(() => {
    if (mode !== 'visual' || !ref.current) return;
    const html = toEditorHtml(value);
    if (ref.current.innerHTML !== html) ref.current.innerHTML = html;
  }, [value, mode]);
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    if (range.current && sel) {
      sel.removeAllRanges();
      sel.addRange(range.current);
    }
  };
  const exec = (cmd: string, arg?: string) => {
    restore();
    // execCommand is deprecated but remains the only cross-browser way to edit rich text without a library.
    // CSS styling makes colours and fonts come out as style="" (which the document renderer reads).
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, arg);
    onChange(ref.current?.innerHTML ?? '');
    saveRange();
  };
  const tool = (icon: ReactNode, label: string, onClick: () => void) => (
    <button key={label} type="button" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg [&>svg]:size-[15px]">
      {icon}
    </button>
  );
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface focus-within:border-info/60 focus-within:shadow-[0_0_0_4px_rgb(0_102_204/0.12)]">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-2/70 p-1">
        {mode === 'visual' && (
          <>
            {tool(<Bold />, 'Bold', () => exec('bold'))}
            {tool(<Italic />, 'Italic', () => exec('italic'))}
            {tool(<Underline />, 'Underline', () => exec('underline'))}
            <span className="mx-0.5 h-4 w-px bg-line" />
            {extended ? (
              (['h1', 'h2', 'h3', 'h4'] as const).map((h) => (
                <button key={h} type="button" title={`Heading ${h[1]}`} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('formatBlock', h)} className="grid h-7 min-w-7 place-items-center rounded-md px-1 text-[11px] font-bold text-muted transition-colors hover:bg-surface hover:text-fg">
                  {h.toUpperCase()}
                </button>
              ))
            ) : (
              <>
                {tool(<Heading2 />, 'Heading', () => exec('formatBlock', 'h2'))}
                {tool(<Heading3 />, 'Subheading', () => exec('formatBlock', 'h3'))}
              </>
            )}
            {tool(<Type />, 'Paragraph', () => exec('formatBlock', 'p'))}
            {extended && (
              <>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <select
                  aria-label="Font"
                  defaultValue=""
                  onMouseDown={saveRange}
                  onChange={(e) => {
                    if (e.target.value) exec('fontName', e.target.value);
                    e.target.value = '';
                  }}
                  className="h-7 rounded-md border border-line bg-surface px-1.5 text-[11px] text-muted"
                >
                  <option value="">Font</option>
                  {FONTS.map((f) => (
                    <option key={f} value={f} style={{ fontFamily: f }}>
                      {f}
                    </option>
                  ))}
                </select>
                <label title="Text colour" className="relative grid size-7 cursor-pointer place-items-center rounded-md hover:bg-surface" onMouseDown={saveRange}>
                  <span className="text-[13px] font-bold text-fg underline decoration-[3px] decoration-danger underline-offset-2">A</span>
                  <input type="color" aria-label="Text colour" className="absolute inset-0 cursor-pointer opacity-0" defaultValue="#c00000" onChange={(e) => exec('foreColor', e.target.value)} />
                </label>
                <label title="Highlight" className="relative grid size-7 cursor-pointer place-items-center rounded-md hover:bg-surface" onMouseDown={saveRange}>
                  <span className="rounded-sm bg-warning/40 px-1 text-[12px] font-bold text-fg">ab</span>
                  <input type="color" aria-label="Highlight colour" className="absolute inset-0 cursor-pointer opacity-0" defaultValue="#fff59d" onChange={(e) => exec('hiliteColor', e.target.value)} />
                </label>
              </>
            )}
            <span className="mx-0.5 h-4 w-px bg-line" />
            {tool(<List />, 'Bulleted list', () => exec('insertUnorderedList'))}
            {tool(<ListOrdered />, 'Numbered list', () => exec('insertOrderedList'))}
            {tool(<AlignLeft />, 'Align left', () => exec('justifyLeft'))}
            {tool(<AlignCenter />, 'Align centre', () => exec('justifyCenter'))}
            {tool(<AlignRight />, 'Align right', () => exec('justifyRight'))}
            {tool(<Link2 />, 'Link', () => {
              const url = window.prompt('Link address (https://… or {{link}})');
              if (url && /^(https?:\/\/|mailto:|\{\{)/i.test(url.trim())) exec('createLink', url.trim());
            })}
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          {mode === 'visual' && <TagPicker def={def} compact onPick={(t) => exec('insertText', t)} />}
          <span className="inline-flex rounded-lg bg-surface p-0.5 text-[11px]">
            {(['visual', 'html'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={clsx('inline-flex items-center gap-1 rounded-md px-2 py-0.5', mode === m ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg')}>
                {m === 'visual' ? <Type className="size-3" /> : <Code2 className="size-3" />}
                {m === 'visual' ? 'Text' : 'HTML'}
              </button>
            ))}
          </span>
        </span>
      </div>
      {mode === 'visual' ? (
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          aria-label={extended ? 'Document body' : 'Email body'}
          data-placeholder={placeholder}
          onInput={() => onChange(ref.current?.innerHTML ?? '')}
          onKeyUp={saveRange}
          onMouseUp={saveRange}
          onBlur={saveRange}
          className="prose-email max-w-none overflow-y-auto px-3.5 py-3 text-sm leading-relaxed outline-none empty:before:pointer-events-none empty:before:text-muted empty:before:content-[attr(data-placeholder)]"
          style={{ minHeight }}
        />
      ) : (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} className="block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-xs leading-relaxed outline-none" style={{ minHeight }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ preview
function sampleValue(f: FieldDef): RecordData[string] {
  switch (f.type) {
    case 'number':
    case 'computed':
      return 1250;
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'datetime':
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    case 'email':
    case 'user-email':
      return 'priya@example.com';
    case 'phone':
      return '+91 98765 43210';
    case 'checkbox':
      return true;
    case 'select':
    case 'combobox':
    case 'dependent-select':
      return f.options?.[0] ?? f.label;
    case 'multiselect':
      return f.options?.slice(0, 2) ?? [f.label];
    default:
      return f.label;
  }
}

export function MessagePreview({ data, def, flowName }: { data: MessageNodeData; def: WorkflowDef; flowName: string }) {
  const [tab, setTab] = useState<'email' | 'whatsapp'>(data.email || !data.whatsapp ? 'email' : 'whatsapp');
  const ctx = useMemo(() => {
    const sample = Object.fromEntries(def.fields.map((f) => [f.key, sampleValue(f)])) as RecordData;
    const title = def.fields.filter((f) => f.searchKey).map((f) => String(sample[f.key] ?? '')).join(' · ') || '#1024';
    return { fields: def.fields, data: sample, extra: { record_number: 1024, record_title: title, workflow_name: flowName, current_stage: def.stages[1]?.name ?? def.stages[0]?.name ?? '', link: 'https://app.example.com/r/1024' } };
  }, [def, flowName]);

  const email = data.email;
  const html = email ? (isHtmlBody(email.body) ? sanitizeEmailHtml(renderTemplate(email.body, ctx, { html: true })) : renderTemplate(email.body, ctx, { html: true }).replace(/\n/g, '<br>')) : '';
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#1d1d1f;background:#fff}h2{font-size:18px;margin:.4em 0}h3{font-size:15px;margin:.4em 0}a{color:#0066cc}ul,ol{padding-left:1.3em}</style></head><body>${html || '<p style="color:#888">The email body is empty.</p>'}</body></html>`;
  const wa = data.whatsapp;
  const waText = wa ? (wa.template ? null : renderTemplate(wa.body, ctx)) : '';

  return (
    <div>
      <div className="mb-3 inline-flex rounded-xl bg-surface-2 p-1 text-[12px]">
        {(['email', 'whatsapp'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={clsx('inline-flex items-center gap-1.5 rounded-[9px] px-3 py-1', tab === t ? 'bg-surface font-medium shadow-[0_1px_3px_rgb(0_0_0/0.1)]' : 'text-muted')}>
            {t === 'email' ? <Mail className="size-3.5" /> : <MessageCircle className="size-3.5" />}
            {t === 'email' ? 'Email' : 'WhatsApp'}
          </button>
        ))}
      </div>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
        <Eye className="size-3.5" /> Filled with sample values for each field
      </p>
      {tab === 'email' ? (
        email ? (
          <div className="overflow-hidden rounded-2xl border border-line bg-white text-[#1d1d1f] shadow-[var(--shadow-soft)]">
            <div className="space-y-0.5 border-b border-[#e5e5ea] bg-[#f5f5f7] px-4 py-3 text-xs">
              <p>
                <span className="text-[#6e6e73]">To:</span> {renderTemplate(email.to, ctx) || <i className="text-[#6e6e73]">no recipients</i>}
              </p>
              {email.cc && (
                <p>
                  <span className="text-[#6e6e73]">Cc:</span> {renderTemplate(email.cc, ctx)}
                </p>
              )}
              <p className="pt-1 text-sm font-semibold">{renderTemplate(email.subject, ctx) || <i className="font-normal text-[#6e6e73]">No subject</i>}</p>
            </div>
            <iframe title="Email preview" sandbox="" srcDoc={doc} className="h-72 w-full bg-white" />
          </div>
        ) : (
          <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">No email configured for this message.</p>
        )
      ) : wa ? (
        <div className="rounded-2xl bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
          <p className="mb-2 text-center text-[11px] text-[#54656f] dark:text-[#8696a0]">To {renderTemplate(wa.to, ctx) || '—'}</p>
          <div className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-[#d9fdd3] px-3 py-2 text-[13px] text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
            {wa.template ? (
              <>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">Template · {wa.template.name}</p>
                {wa.template.params.filter((p) => p.trim()).map((p, i) => (
                  <p key={i}>
                    <span className="opacity-60">{`{{${i + 1}}}`}</span> {renderTemplate(p, ctx)}
                  </p>
                ))}
                {!wa.template.params.some((p) => p.trim()) && <p className="opacity-70">No variables</p>}
              </>
            ) : (
              <p className="whitespace-pre-wrap">{waText || <i className="opacity-60">Empty message</i>}</p>
            )}
            <p className="mt-1 text-right text-[10px] opacity-60">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>
      ) : (
        <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">No WhatsApp message configured.</p>
      )}
    </div>
  );
}
