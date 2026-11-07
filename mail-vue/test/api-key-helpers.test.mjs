import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
	buildSendExamples,
	exampleSender,
	keyState,
	resolveExpiresAt,
	senderSuggestions
} from '../src/views/api-key/api-key-helpers.js';

test('expiry presets resolve to an absolute timestamp or no expiry', () => {
	const now = Date.UTC(2026, 10, 7, 12, 0, 0);
	assert.equal(resolveExpiresAt('never', null, now), null);
	assert.equal(resolveExpiresAt('30', null, now), new Date(now + 30 * 86400000).toISOString());
	assert.equal(resolveExpiresAt('custom', null, now), undefined);

	const custom = new Date(resolveExpiresAt('custom', new Date(2027, 0, 15), now));
	assert.equal(custom.getFullYear(), 2027);
	assert.equal(custom.getMonth(), 0);
	assert.equal(custom.getDate(), 15);
	assert.equal(custom.getHours(), 23);
});

test('sender suggestions offer one wildcard per configured domain without duplicates', () => {
	assert.deepEqual(
		senderSuggestions(['@example.com', '@Example.org', '@example.com'], ['ops@example.com']),
		['ops@example.com', '*@example.com', '*@example.org']
	);
});

test('examples use a sender the key is actually allowed to use', () => {
	assert.equal(exampleSender(['*@notify.example.com']), 'noreply@notify.example.com');
	assert.equal(exampleSender(['*@a.example', 'bot@b.example']), 'bot@b.example');
	assert.equal(exampleSender([], ['@example.net']), 'noreply@example.net');
	assert.equal(exampleSender([], []), 'noreply@example.com');
});

test('generated examples call the public endpoint with a bearer key and an idempotency key', () => {
	const examples = buildSendExamples({
		origin: 'https://mail.example.com',
		key: 'cmk_test',
		sender: 'noreply@example.com'
	});
	for (const code of Object.values(examples)) {
		assert.match(code, /https:\/\/mail\.example\.com\/api\/public\/sendEmail/);
		assert.match(code, /Bearer cmk_test/);
		assert.match(code, /Idempotency-Key/);
		assert.match(code, /noreply@example\.com/);
	}
	const payload = examples.curl.slice(examples.curl.indexOf("-d '") + 4, examples.curl.indexOf("'\n"));
	assert.equal(JSON.parse(payload).sendEmail, 'noreply@example.com');
});

test('key state distinguishes disabled and expired keys', () => {
	const now = Date.UTC(2026, 10, 7);
	assert.equal(keyState({status: 0, expiresAt: null}, now), 'active');
	assert.equal(keyState({status: 1, expiresAt: null}, now), 'disabled');
	assert.equal(keyState({status: 0, expiresAt: '2026-11-06T00:00:00.000Z'}, now), 'expired');
});

test('every locale defines the API key page messages', () => {
	const view = readFileSync(new URL('../src/views/api-key/index.vue', import.meta.url), 'utf8');
	const keys = [...new Set([...view.matchAll(/\$?t\('(apiKey[A-Za-z]*)'/g)].map(match => match[1]))];
	assert.ok(keys.length > 20);
	for (const locale of ['zh', 'zh-tw', 'en', 'ja']) {
		const source = readFileSync(new URL(`../src/i18n/${locale}.js`, import.meta.url), 'utf8');
		for (const key of [...keys, 'apiKeys']) {
			assert.match(source, new RegExp(`\\n\\s+${key}:`), `${locale} is missing ${key}`);
		}
	}
});
