import { describe, expect, it } from 'vitest';
import emailService from '../src/service/email-service';
import { attConst } from '../src/const/entity-const';

function cidAtt(contentId, key) {
	return { contentId, key, type: attConst.type.ATT };
}

describe('inline image src rewriting', () => {
	it('maps cid images to stored attachment keys and marks only the used ones as embedded', async () => {
		const used = cidAtt('<logo@mail>', 'attachments/logo.png');
		const unused = cidAtt('<unused@mail>', 'attachments/unused.png');
		const html = '<p>Hi</p><img alt="logo" src="cid:logo@mail"><img src="cid:missing@mail">';

		const result = await emailService.imgReplace(html, [used, unused], '');

		expect(result).toBe('<p>Hi</p><img alt="logo" src="{{domain}}attachments/logo.png"><img src="cid:missing@mail">');
		expect(used.type).toBe(attConst.type.EMBED);
		expect(unused.type).toBe(attConst.type.ATT);
	});

	it('uses the first attachment when several share a content id', async () => {
		const first = cidAtt('<dup@mail>', 'attachments/first.png');
		const second = cidAtt('dup@mail', 'attachments/second.png');

		const result = await emailService.imgReplace('<img src="cid:dup@mail">', [first, second], '');

		expect(result).toBe('<img src="{{domain}}attachments/first.png">');
		expect(second.type).toBe(attConst.type.ATT);
	});

	it('turns object storage urls into domain placeholders', async () => {
		const html = '<img src="https://oss.example.com/attachments/a.png"><img src="https://other.example.com/a.png">';

		const result = await emailService.imgReplace(html, [], 'oss.example.com');

		expect(result).toBe('<img src="{{domain}}attachments/a.png"><img src="https://other.example.com/a.png">');
	});

	it('leaves every byte outside the rewritten attribute untouched', async () => {
		const html = '<div class=x><p>未闭合<b>粗体<img width=10 src="cid:a@b" data-x=\'1\'><!-- note --></div>';

		const result = await emailService.imgReplace(html, [cidAtt('<a@b>', 'attachments/a.png')], '');

		expect(result).toBe('<div class=x><p>未闭合<b>粗体<img width=10 src="{{domain}}attachments/a.png" data-x=\'1\'><!-- note --></div>');
	});

	it.each([
		'<meta charset="gb2312">',
		'<meta http-equiv="Content-Type" content="text/html; charset=gbk">'
	])('keeps decoded unicode text intact when the markup declares a legacy charset: %s', async meta => {
		const body = '<p>验证码：中文内容 – “引号” 😀</p>';
		const html = `<html><head>${meta}</head><body>${body}<img src="cid:a@b"></body></html>`;

		const result = await emailService.imgReplace(html, [cidAtt('<a@b>', 'attachments/a.png')], '');

		expect(result).toBe(`<html><head>${meta}</head><body>${body}<img src="{{domain}}attachments/a.png"></body></html>`);
	});

	it('returns the original string when there is nothing to rewrite', async () => {
		const html = '<p>plain</p><img src="https://example.com/a.png">';

		expect(await emailService.imgReplace(html, [], 'oss.example.com')).toBe(html);
		expect(await emailService.imgReplace('', [cidAtt('<a@b>', 'k')], '')).toBe('');
	});
});
