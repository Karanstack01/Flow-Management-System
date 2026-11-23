import clsx from 'clsx';

interface LogoProps {
  /** white = for dark backgrounds, dark = for light backgrounds. */
  variant?: 'white' | 'dark' | 'symbol';
  /** Show only the S mark (collapsed sidebar, small spaces). */
  markOnly?: boolean;
  /** Height comes from the class (e.g. h-7); width follows the artwork. */
  className?: string;
  showTagline?: boolean;
}

/**
 * The brand files in /public are 4358×4358 squares with the wordmark in a thin band,
 * so they render tiny. These use tightly-cropped transparent versions of the same artwork.
 */
export function StackDroveLogo({ variant = 'white', markOnly = false, className, showTagline = false }: LogoProps) {
  const light = variant !== 'dark';
  if (variant === 'symbol' || markOnly) {
    return <img src={light ? '/stackdrove-mark-light.svg' : '/stackdrove-mark-dark.svg'} alt="StackDrove" className={clsx('h-8 w-auto select-none', className)} draggable={false} />;
  }
  return (
    <span className={clsx('flex items-center gap-2.5', className)}>
      <img src={light ? '/stackdrove-wordmark-light.svg' : '/stackdrove-wordmark-dark.svg'} alt="StackDrove" className="h-full w-auto select-none" draggable={false} />
      {showTagline && <span className="border-l border-current/20 pl-2.5 text-xs font-medium opacity-80">Flow Management System</span>}
    </span>
  );
}
