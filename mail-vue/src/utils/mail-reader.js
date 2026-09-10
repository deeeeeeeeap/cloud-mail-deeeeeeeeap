import { isSafeImageData, sanitizeHtml, serializeHtmlFragment } from './html-sanitize.js';

export function inlineAttachmentKey(source) {
  const input = String(source || '').trim().replace(/^\{\{domain\}\}/, '/');
  let pathname = input;
  if (/^https?:\/\//i.test(input)) {
    try { pathname = new URL(input).pathname; } catch { return null; }
  }
  const match = pathname.match(/^\/?(attachments\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,255})$/);
  return match ? match[1] : null;
}

export function prepareMailBody(html, { remoteImages = false, inlineUrls = new Map() } = {}) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeHtml(html);
  const inlineKeys = new Set();
  let remoteCount = 0;
  for (const img of template.content.querySelectorAll('img')) {
    const source = img.getAttribute('src') || '';
    const key = inlineAttachmentKey(source);
    img.removeAttribute('src');
    if (key) {
      inlineKeys.add(key);
      const url = inlineUrls.get(key);
      // Blob URLs are created by our authenticated fetch, never taken from mail.
      if (typeof url === 'string' && url.startsWith('blob:')) img.setAttribute('src', url);
    } else if (isSafeImageData(source)) {
      img.setAttribute('src', source);
    } else if (/^https:\/\//i.test(source)) {
      remoteCount++;
      if (remoteImages) img.setAttribute('src', source);
    }
  }
  return { html: serializeHtmlFragment(template.content), inlineKeys: [...inlineKeys], remoteCount };
}

export function mailDocument(body, remoteImages = false) {
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:${remoteImages ? ' https:' : ''}; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{margin:0;padding:0;background:#fff;color:#13181d}body{margin:0;padding:12px;box-sizing:border-box;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse}pre{white-space:pre-wrap}a{color:#0e70df}*{box-sizing:border-box}</style></head><body>${body}</body></html>`;
}

export function inlineAttachmentUrl(baseUrl, { emailId, key, scope = 'user' }) {
  if (!Number.isSafeInteger(Number(emailId)) || Number(emailId) <= 0 || !inlineAttachmentKey(key)) throw new Error('Invalid inline attachment');
  const prefix = scope === 'all' ? '/allEmail' : '/email';
  return `${String(baseUrl || '/api').replace(/\/$/, '')}${prefix}/attachment/inline?${new URLSearchParams({ emailId: String(emailId), key })}`;
}
