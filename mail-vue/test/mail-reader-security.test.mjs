import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const requireWorker = createRequire(new URL('../../mail-worker/package.json', import.meta.url));
const { parseHTML } = requireWorker('linkedom');
const { document } = parseHTML('<html><body></body></html>');
globalThis.document = document;
const { sanitizeHtml, sanitizeStyleAttribute, safeLink } = await import('../src/utils/html-sanitize.js');
const { inlineAttachmentKey, inlineAttachmentUrl, prepareMailBody, mailDocument } = await import('../src/utils/mail-reader.js');

test('CSS escapes, comments, functions and positioning cannot bypass the allowlist', () => {
  for (const css of ['p\\6fsition:fixed', 'po/**/sition:fixed', 'position:fixed', 'position:absolute', 'background:url(https://tracker.invalid)', 'color:v\\61r(--secret)', '--p:fixed', 'z-index:999999', 'transform:scale(100)', 'font:12px url(https://tracker.invalid)', 'color:var(--secret)']) {
    assert.equal(sanitizeStyleAttribute(css), '', css);
  }
  assert.match(sanitizeStyleAttribute('color:red; padding:12px'), /color: red/);
});

test('untrusted tags, attributes, foreign content and form controls are removed', () => {
  const value = sanitizeHtml('<script>alert(1)</script><svg><a onclick="x()">x</a></svg><form><input></form><p id="location" onclick="x()" style="position:fixed">hello</p><a href="javascript:alert(1)" target="_top" ping="https://tracker.invalid">link</a><img src="data:image/svg+xml;base64,AAAA" srcset="https://tracker.invalid 2x">');
  assert.doesNotMatch(value, /script|svg|form|input|onclick|javascript|target=|ping=|srcset=|position|id=/i);
  assert.match(value, /hello/);
});

test('links reject relative app routes, credentials, script URLs and control characters', () => {
  for (const href of ['javascript:alert(1)', '/api/email/delete', 'https://user:password@example.com', 'https://example.com\n.evil', 'data:text/html,hello']) assert.equal(safeLink(href), null);
  assert.equal(safeLink('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeLink('mailto:user@example.com'), 'mailto:user@example.com');
});

test('legacy inline resource formats resolve only to a strict key, never a credentialed third-party URL', () => {
  for (const src of ['attachments/abc.png', '/attachments/abc.png', '{{domain}}attachments/abc.png', 'https://old-storage.example/attachments/abc.png']) assert.equal(inlineAttachmentKey(src), 'attachments/abc.png');
  for (const src of ['attachments/../secret', 'attachments/a%2fb', '/api/private', 'https://example.com/elsewhere', 'attachments/a?token=secret']) assert.equal(inlineAttachmentKey(src), null);
});

test('remote images are disabled until consent and inline resources only use trusted blobs', () => {
  const html = '<p>hello</p><img src="https://tracker.invalid/pixel"><img src="{{domain}}attachments/abc.png">';
  const blocked = prepareMailBody(html);
  assert.equal(blocked.remoteCount, 1);
  assert.deepEqual(blocked.inlineKeys, ['attachments/abc.png']);
  assert.doesNotMatch(blocked.html, /src=/);
  const allowed = prepareMailBody(html, { remoteImages: true, inlineUrls: new Map([['attachments/abc.png', 'blob:trusted']]) });
  assert.match(allowed.html, /https:\/\/tracker.invalid\/pixel/);
  assert.match(allowed.html, /blob:trusted/);
  assert.doesNotMatch(prepareMailBody('<img src="blob:untrusted">').html, /blob:untrusted/);
});

test('attachment endpoint is bound to the displayed email and scope, with no token in the URL', () => {
  const url = inlineAttachmentUrl('/api/', { emailId: 12, key: 'attachments/abc.png', scope: 'user' });
  assert.equal(url, '/api/email/attachment/inline?emailId=12&key=attachments%2Fabc.png');
  assert.match(inlineAttachmentUrl('/api', { emailId: 12, key: 'attachments/abc.png', scope: 'all' }), /allEmail\/attachment\/inline/);
  assert.throws(() => inlineAttachmentUrl('/api', { emailId: -1, key: 'attachments/abc.png' }));
});

test('the reader uses a scriptless sandbox and blocks non-image requests independently of sanitization', () => {
  const component = readFileSync(new URL('../src/components/shadow-html/index.vue', import.meta.url), 'utf8');
  assert.match(component, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(component, /sandbox="[^"]*allow-scripts/);
  const doc = mailDocument('<p>safe</p>');
  assert.match(doc, /script-src 'none'/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /img-src data: blob:;/);
  assert.match(mailDocument('', true), /img-src data: blob: https:;/);
});
