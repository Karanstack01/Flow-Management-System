import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          'inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-xl font-medium transition-[background-color,box-shadow,transform,opacity,color] duration-200 ease-[var(--ease-apple)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
          size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
          variant === 'primary' && 'bg-primary text-primary-fg shadow-[0_1px_2px_rgb(0_0_0/0.12)] hover:opacity-[0.88]',
          variant === 'secondary' && 'border border-line bg-surface text-fg shadow-[0_1px_1px_rgb(0_0_0/0.03)] hover:bg-surface-2',
          variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
          variant === 'danger' && 'bg-danger text-white hover:opacity-90',
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx('input', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx('input pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx('input min-h-20', className)} {...rest} />;
});

export function FormField({ label, error, hint, required, children, className }: { label: string; error?: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

/** On/off switch (green when on). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-[var(--ease-apple)] disabled:opacity-45',
        checked ? 'bg-success' : 'bg-line',
      )}
    >
      <span className={clsx('inline-block size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[var(--ease-apple)]', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  );
}

export function Badge({ children, color, tone = 'neutral', className }: { children: ReactNode; color?: string; tone?: 'neutral' | 'danger' | 'warning' | 'success' | 'primary' | 'info'; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1 truncate rounded-full px-2.5 py-0.5 text-xs font-medium',
        !color && tone === 'neutral' && 'bg-surface-2 text-muted',
        !color && tone === 'danger' && 'bg-danger-soft text-danger',
        !color && tone === 'warning' && 'bg-warning-soft text-warning',
        !color && tone === 'success' && 'bg-success-soft text-success',
        !color && tone === 'primary' && 'bg-primary-soft text-primary',
        !color && tone === 'info' && 'bg-info-soft text-info',
        className,
      )}
      style={color ? { background: `${color}22`, color } : undefined}
    >
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/80 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[26px] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{(error as Error).message ?? 'Something went wrong'}</div>;
}

/** Native <dialog> modal: focus trapping, Esc to close and backdrop for free. */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={clsx('m-auto w-[calc(100%-2rem)] overflow-hidden rounded-[22px] border border-line/70 bg-surface p-0 text-fg shadow-[var(--shadow-float)]', wide ? 'max-w-4xl' : 'max-w-lg')}
    >
      <header className="flex items-center justify-between px-6 pb-2 pt-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted transition-colors hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>
      <div className="max-h-[70vh] overflow-y-auto px-6 py-4">{children}</div>
      {footer && <footer className="flex justify-end gap-2 border-t border-line/70 bg-surface-2/40 px-6 py-3.5">{footer}</footer>}
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-surface-2 p-1 [scrollbar-width:none]">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx(
            'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 py-1.5 text-[13px] transition-all duration-200 ease-[var(--ease-apple)]',
            value === it.value ? 'bg-surface font-medium text-fg shadow-[0_1px_3px_rgb(0_0_0/0.1)]' : 'text-muted hover:text-fg',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
