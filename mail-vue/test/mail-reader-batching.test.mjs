import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
const requireWorker = createRequire(new URL('../../mail-worker/package.json', import.meta.url));
const { parseHTML } = requireWorker('linkedom');
const { document } = parseHTML('<html><body></body></html>');
globalThis.document = document;
const { createMailBody, prepareMailBody, inlineAttachmentUrl, mailDocument } = await import('../src/utils/mail-reader.js');
const { safeLink } = await import('../src/utils/html-sanitize.js');

const settle = () => new Promise(resolve => setImmediate(resolve));
const mail = (count, prefix = 'a') => '<p style="color:red">hello</p><img src="https://tracker.invalid/pixel">'
  + Array.from({ length: count }, (_, index) => `<img src="{{domain}}attachments/${prefix}${index}.png">`).join('');

test('a prepared message gives the same result as preparing it from scratch', () => {
  const html = `${mail(2)}<img src="blob:untrusted"><script>alert(1)</script>`;
  const body = createMailBody(html);
  const inlineUrls = new Map([['attachments/a0.png', 'blob:trusted-0'], ['attachments/a1.png', 'https://not-a-blob.invalid']]);
  for (const options of [undefined, { remoteImages: true }, { inlineUrls }, { remoteImages: true, inlineUrls }]) {
    assert.deepEqual(body.prepare(options), prepareMailBody(html, options));
  }
  const prepared = body.prepare({ inlineUrls });
  assert.match(prepared.html, /blob:trusted-0/);
  assert.doesNotMatch(prepared.html, /untrusted|not-a-blob|tracker|script/);
});

test('re-resolving images reuses the sanitized message', t => {
  const created = [];
  const createElement = document.createElement.bind(document);
  t.mock.method(document, 'createElement', tag => { created.push(tag); return createElement(tag); });
  const body = createMailBody(mail(3));
  const sanitizeTemplates = created.filter(tag => tag === 'template').length;
  for (let index = 0; index < 5; index++) body.prepare({ inlineUrls: new Map([[`attachments/a${index % 3}.png`, `blob:${index}`]]) });
  assert.equal(created.filter(tag => tag === 'template').length, sanitizeTemplates + 5, 'one parse per prepare, no re-sanitizing');
  assert.ok(created.filter(tag => tag === 'span').length <= 1, 'style validation reuses one probe element');
});

test('a declaration rejected by CSSOM cannot read back an earlier value from the shared probe', async () => {
  // A CSSOM stand-in that rejects values the way browsers do; linkedom accepts anything.
  const fakeDocument = {
    createElement: () => {
      const values = new Map();
      return { style: {
        set cssText(value) { if (value === '') values.clear(); },
        setProperty(name, value) { if (!/bogus/.test(value)) values.set(name, value); },
        getPropertyValue: name => values.get(name) ?? ''
      } };
    }
  };
  const previous = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const { sanitizeStyleAttribute } = await import('../src/utils/html-sanitize.js?fresh-probe');
    assert.equal(sanitizeStyleAttribute('color: red; color: bogus; margin-top: 2px; margin-top: bogus'), 'color: red; margin-top: 2px');
    assert.equal(sanitizeStyleAttribute('color: bogus'), '');
  } finally {
    globalThis.document = previous;
  }
});

const source = readFileSync(new URL('../src/components/shadow-html/index.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[^\n]+\r?$/gm, '')
  .replace(/import\.meta\.env\.VITE_BASE_URL/g, 'undefined');

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay) { timers.set(++nextId, { callback, at: time + delay }); return nextId; },
    clearTimeout: id => { timers.delete(id); },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time) break;
        timers.delete(id);
        timer.callback();
      }
      await settle();
    }
  };
}

function mountReader(html) {
  const clock = fakeClock();
  const props = Vue.reactive({ html, emailId: 7, scope: 'user' });
  const fetches = [];
  const revoked = [];
  let objectUrls = 0;
  let sanitized = 0;
  let unmount;
  const adapters = {
    computed: Vue.computed, ref: Vue.ref, watch: Vue.watch, onBeforeUnmount: fn => { unmount = fn; },
    useI18n: () => ({ locale: Vue.ref('zh') }), defineProps: () => props,
    createMailBody: value => { sanitized++; return createMailBody(value); },
    inlineAttachmentUrl, mailDocument, safeLink,
    localStorage: { getItem: () => 'token' },
    URL: { createObjectURL: () => `blob:reader/${++objectUrls}`, revokeObjectURL: url => revoked.push(url) },
    fetch: (url, { signal }) => new Promise((resolve, reject) => {
      const key = new URL(url, 'https://mail.invalid').searchParams.get('key');
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      fetches.push({ key, resolve: () => resolve(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })) });
    }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}
  };
  const state = new Function(...Object.keys(adapters), `${source}\nreturn { inlineUrls, srcdoc, frameHeight, loadingInline, inlineFailed };`)(...Object.values(adapters));
  const published = [];
  Vue.watch(state.inlineUrls, urls => { if (urls.size) published.push([...urls.keys()]); }, { flush: 'sync' });
  return {
    ...state, props, clock, fetches, revoked, published,
    get sanitized() { return sanitized; },
    unmount: () => unmount(),
    async load(key) {
      fetches.find(entry => entry.key === key).resolve();
      for (let round = 0; round < 5; round++) await settle();
    }
  };
}

test('inline images that arrive together are published to the frame once', async () => {
  const reader = mountReader(mail(6));
  for (let index = 0; index < 6; index++) await reader.load(`attachments/a${index}.png`);
  assert.equal(reader.published.length, 1);
  assert.equal(reader.inlineUrls.value.size, 6);
  for (let index = 1; index <= 6; index++) assert.match(reader.srcdoc.value, new RegExp(`blob:reader/${index}"`));
  assert.equal(reader.sanitized, 1, 'the message is sanitized once for all image batches');
  assert.equal(reader.loadingInline.value, false);
  assert.equal(reader.clock.timers.size, 0);
  assert.match(reader.srcdoc.value, /img-src data: blob:;/, 'the frame CSP is unchanged');
});

test('slow inline images are published at most every 250ms', async () => {
  const reader = mountReader(mail(6));
  await reader.load('attachments/a0.png');
  await reader.clock.advance(100);
  await reader.load('attachments/a1.png');
  assert.equal(reader.published.length, 0);
  await reader.clock.advance(150);
  assert.deepEqual(reader.published, [['attachments/a0.png', 'attachments/a1.png']]);
  await reader.clock.advance(150);
  await reader.load('attachments/a2.png');
  await reader.clock.advance(250);
  assert.equal(reader.published.length, 2);
  for (const index of [3, 4, 5]) await reader.load(`attachments/a${index}.png`);
  assert.equal(reader.published.length, 3);
  assert.equal(reader.inlineUrls.value.size, 6);
});

test('opening another message revokes images that were not published yet', async () => {
  const reader = mountReader(mail(2));
  await reader.load('attachments/a0.png');
  reader.props.html = mail(1, 'b');
  await settle();
  assert.deepEqual(reader.revoked, ['blob:reader/1']);
  assert.equal(reader.inlineFailed.value, false, 'aborted requests of the old message are not failures');
  await reader.load('attachments/b0.png');
  assert.deepEqual([...reader.inlineUrls.value.keys()], ['attachments/b0.png']);
  assert.doesNotMatch(reader.srcdoc.value, /blob:reader\/1"/);
});

test('closing the reader revokes unpublished images and stops the batch timer', async () => {
  const reader = mountReader(mail(3));
  await reader.load('attachments/a0.png');
  reader.unmount();
  assert.deepEqual(reader.revoked, ['blob:reader/1']);
  assert.equal(reader.clock.timers.size, 0);
  await reader.clock.advance(1000);
  assert.equal(reader.published.length, 0);
});

test('publishing images keeps the measured height; a new message starts from the default', async () => {
  const reader = mountReader(mail(2));
  reader.frameHeight.value = 900;
  await reader.load('attachments/a0.png');
  await reader.load('attachments/a1.png');
  assert.equal(reader.published.length, 1);
  assert.equal(reader.frameHeight.value, 900);
  reader.props.html = mail(1, 'b');
  await settle();
  assert.equal(reader.frameHeight.value, 160);
});
