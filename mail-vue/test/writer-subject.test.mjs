import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {forwardSubject} from '../src/layout/write/subject.js';

test('forwarding adds a single Fwd: prefix', () => {
	assert.equal(forwardSubject('Invoice'), 'Fwd: Invoice');
	assert.equal(forwardSubject(undefined), 'Fwd: ');
	for (const subject of ['Fwd: Invoice', 'FW: Invoice', 'fwd：Invoice', '转发：发票', '轉寄: 發票', '転送: 請求書']) {
		assert.equal(forwardSubject(subject), subject);
	}
	assert.equal(forwardSubject('Fwdx: Invoice'), 'Fwd: Fwdx: Invoice');
});

test('the writer forwards with the prefix and releases focus when hidden', () => {
	const writer = readFileSync(new URL('../src/layout/write/index.vue', import.meta.url), 'utf8');
	assert.match(writer, /form\.subject = forwardSubject\(email\.subject\)/);
	assert.match(writer, /<div ref="writerRoot" class="send" v-show="show">/);
	assert.match(writer, /watch\(show, visible => \{\s*if \(!visible && writerRoot\.value\?\.contains\(document\.activeElement\)\) document\.activeElement\.blur\(\)/);
});
