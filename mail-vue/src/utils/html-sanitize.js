// HTML is untrusted even when it came from our database. The email reader also
// uses a scriptless sandbox; this allowlist is defense in depth, not that boundary.
const ALLOWED_TAGS = new Set(('a abbr address article b bdi bdo blockquote br caption center cite code col colgroup dd del details div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr').split(' '));
const DROP_CONTENT = new Set(('script style iframe object embed link meta base form svg math template noscript frame frameset applet audio video source track input button select textarea option').split(' '));
const ALLOWED_ATTRS = new Set(('title alt width height align valign bgcolor border cellpadding cellspacing colspan rowspan span dir lang color face size start reversed type datetime open').split(' '));
const SAFE_PROPERTIES = new Set(('color background-color font font-family font-size font-style font-weight font-variant line-height letter-spacing word-spacing text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-transform white-space word-break overflow-wrap vertical-align display width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-top border-right border-bottom border-left border-collapse border-spacing border-radius box-sizing table-layout list-style-type list-style-position position').split(' '));
const SAFE_POSITIONS = new Set(['static', 'relative', 'initial', 'inherit', 'unset', 'revert']);
const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;

export function isSafeImageData(value) {
  return RASTER_DATA.test(String(value || ''));
}

export function safeLink(value) {
  const input = String(value || '').trim();
  if (/[\u0000-\u0020\u007f]/.test(input)) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password) return null;
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function sanitizeStyleAttribute(style = '') {
  const declarations = [];
  for (const declaration of String(style).split(';')) {
    // Fail closed on ambiguous CSS before handing it to the browser parser.
    // Escapes, comments, custom properties and resource functions are not needed
    // to render ordinary mail typography and must not evade the allowlist.
    if (/[\\<>@\u0000-\u001f\u007f]/.test(declaration) || /\/\*|\*\//.test(declaration)) continue;
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!SAFE_PROPERTIES.has(property) || !value) continue;
    if (/(?:url|image(?:-set)?|cross-fade|element|paint|expression|var|env|attr)\s*\(/i.test(value)) continue;
    if (property === 'position' && !SAFE_POSITIONS.has(value.replace(/!\s*important\s*$/i, '').trim().toLowerCase())) continue;
    // CSSOM validates declaration syntax. Only emit properties we explicitly allow.
    const parsed = document.createElement('span').style;
    parsed.setProperty(property, value.replace(/!\s*important\s*$/i, '').trim());
    const normalized = parsed.getPropertyValue(property);
    if (normalized) declarations.push(`${property}: ${normalized}`);
  }
  return declarations.join('; ');
}

export function sanitizeHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  const clean = root => {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === 8) { node.remove(); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.localName.toLowerCase();
      if ((node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml') || DROP_CONTENT.has(tag)) {
        node.remove(); continue;
      }
      clean(node);
      if (!ALLOWED_TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name === 'style') {
          const style = sanitizeStyleAttribute(value);
          if (style) node.setAttribute('style', style); else node.removeAttribute(attr.name);
        } else if (tag === 'a' && name === 'href') {
          const href = safeLink(value);
          if (href) node.setAttribute('href', href); else node.removeAttribute(attr.name);
        } else if (tag === 'img' && name === 'src') {
          // The isolated reader subsequently resolves private resources and blocks
          // all remote images until the reader explicitly grants consent.
          const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
          if (/^(?:https:\/\/|\{\{domain\}\}attachments\/|\/?attachments\/)/i.test(compact) || isSafeImageData(value)) {
            node.setAttribute('src', value);
          } else node.removeAttribute(attr.name);
        } else if (!ALLOWED_ATTRS.has(name)) {
          node.removeAttribute(attr.name);
        }
      }
      if (tag === 'a') node.setAttribute('rel', 'noopener noreferrer');
      if (tag === 'img') { node.setAttribute('referrerpolicy', 'no-referrer'); node.setAttribute('decoding', 'async'); }
    }
  };
  clean(template.content);
  return serializeHtmlFragment(template.content);
}

// Serialize the cleaned fragment itself rather than relying on a DOM shim's
// template.innerHTML cache. No content is inserted into an active document.
export function serializeHtmlFragment(fragment) {
  return Array.from(fragment.childNodes).map(node => {
    if (node.nodeType === 1) return node.outerHTML;
    if (node.nodeType === 3) return node.textContent.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
    return '';
  }).join('');
}
