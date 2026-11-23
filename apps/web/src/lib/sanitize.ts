/**
 * Browser-side HTML sanitiser for markup that is put into the live page (the rich-text email
 * editor sets innerHTML). Message bodies can be written by anyone with MANAGE_RULES and are
 * later opened by admins in the flow editor, so without this an `<img onerror=…>` in a body
 * would run script in the admin's session.
 *
 * DOMParser builds an inert document: nothing in it loads or runs while we clean it.
 */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'svg', 'math', 'template', 'noscript', 'video', 'audio', 'source', 'track', 'canvas', 'portal']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'srcset', 'ping']);
const SAFE_URL = /^(https?:|mailto:|tel:|#|\/(?!\/)|\{\{|<<)/i;

export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/</g, '&lt;');
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (DROP.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        // Strip control characters and whitespace browsers ignore inside "java\tscript:".
        const value = attr.value.replace(/[\u0000- \u007f-\u009f]/g, '');
        const unsafe = name.startsWith('on') || (name === 'style' && /expression|url\s*\(/i.test(value)) || (URL_ATTRS.has(name) && !!value && !SAFE_URL.test(value));
        if (unsafe) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
