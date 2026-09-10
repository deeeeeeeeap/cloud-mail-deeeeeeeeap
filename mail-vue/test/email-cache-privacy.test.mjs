import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEmailCache, deserializeEmailCache } from '../src/utils/email-cache.js';

test('only navigation metadata persists, including when new sensitive fields appear', () => {
  const source = { emailId: 7, accountId: 2, unread: 0, subject: 'private title', content: 'private html', text: 'private text', code: '123456', previewText: 'private preview', recipient: 'secret@example.com', futureSensitiveField: 'secret', attList: [{ key: 'secret' }] };
  const result = safeEmailCache({ contentData: { email: source, showReply: false } });
  assert.deepEqual(result.contentData.email, { emailId: 7, accountId: 2, unread: 0 });
  assert.equal(result.contentData.showReply, false);
  assert.equal(source.code, '123456', 'serialization must not mutate the live message');
});
test('legacy cache is sanitized on hydration and corrupt cache is safe', () => {
  assert.deepEqual(deserializeEmailCache('{broken'), safeEmailCache());
  assert.equal(deserializeEmailCache('null').contentData.email, null);
  assert.deepEqual(deserializeEmailCache(JSON.stringify({ contentData: { email: { emailId: 4, code: '123456', previewText: 'private' } } })).contentData.email, { emailId: 4 });
});
