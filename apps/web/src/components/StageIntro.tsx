import { PlayCircle } from 'lucide-react';

/**
 * Embeddable player URL for the instruction-video links people paste: YouTube (watch, youtu.be,
 * shorts), Google Drive, Vimeo and Loom. Anything else is shown as a plain link.
 */
export function videoEmbedUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const id = (s: string | null | undefined) => (s && /^[\w-]{6,64}$/.test(s) ? s : null);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = id(u.searchParams.get('v')) ?? id(/^\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1]);
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === 'youtu.be') {
    const v = id(u.pathname.slice(1));
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === 'drive.google.com') {
    const f = id(/\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id'));
    return f ? `https://drive.google.com/file/d/${f}/preview` : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const v = /\/(?:video\/)?(\d{5,12})/.exec(u.pathname)?.[1];
    return v ? `https://player.vimeo.com/video/${v}` : null;
  }
  if (host === 'loom.com') {
    const v = id(/\/(?:share|embed)\/([\w-]+)/.exec(u.pathname)?.[1]);
    return v ? `https://www.loom.com/embed/${v}` : null;
  }
  return null;
}

/** What the flow designer wrote for this stage: shown above its form. */
export function StageIntro({ description, video, compact }: { description?: string | null; video?: { title?: string; url: string } | null; compact?: boolean }) {
  if (!description && !video) return null;
  const embed = videoEmbedUrl(video?.url);
  return (
    <div className="space-y-3">
      {description && <p className="whitespace-pre-wrap text-sm text-muted">{description}</p>}
      {video && (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface-2/60">
          <p className="flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium">
            <PlayCircle className="size-4 text-info" />
            {video.title || 'Instruction video'}
            {!embed && (
              <a href={video.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-info underline">
                Open video
              </a>
            )}
          </p>
          {embed && (
            <div className={compact ? 'aspect-video max-h-56 bg-black' : 'aspect-video bg-black'}>
              <iframe
                title={video.title || 'Instruction video'}
                src={embed}
                className="size-full"
                allow="encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
