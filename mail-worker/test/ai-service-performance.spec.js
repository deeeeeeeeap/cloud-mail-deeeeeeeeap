import { describe, expect, it } from 'vitest';
import { collectUrlOrEmailSpans, extractCodeByPattern } from '../src/service/ai-service';

// The original per-candidate check, kept here as the reference the linear spans must match.
function referenceInsideUrlOrEmail(text, index) {
	const start = Math.max(text.lastIndexOf('\n', index - 1) + 1, 0);
	const endIndex = text.indexOf('\n', index);
	const end = endIndex === -1 ? text.length : endIndex;
	const line = text.slice(start, end);
	const re = /(?:https?:\/\/|www\.)\S+|\b\S+@\S+\b/ig;
	let match;
	while ((match = re.exec(line)) !== null) {
		const matchStart = start + match.index;
		if (index >= matchStart && index < matchStart + match[0].length) {
			return true;
		}
	}
	return false;
}

function insideSpans(spans, index) {
	return spans.some(([start, end]) => index >= start && index < end);
}

function seededRandom(seed) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

const ALPHABET = ['a', 'b', 'x', '1', '7', '@', '@', '.', '-', '_', ':', '/', '(', ')', ' ', ' ', '\n', 'h', 't', 'p', 's', 'w', 'W', 'H', 'T', 'P'];
const FRAGMENTS = ['http://', 'https://', 'www.', 'HTTPS://', 'user@host.io', '@@', ' code 483920 '];

describe('verification code extraction performance', () => {
	it('excludes exactly the tokens the original url/email regex excluded', () => {
		const random = seededRandom(20261107);
		let compared = 0;
		for (let caseIndex = 0; caseIndex < 3000; caseIndex++) {
			let text = '';
			const length = 1 + Math.floor(random() * 40);
			while (text.length < length) {
				text += random() < 0.15
					? FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]
					: ALPHABET[Math.floor(random() * ALPHABET.length)];
			}
			const spans = collectUrlOrEmailSpans(text);
			for (let index = 0; index < text.length; index++) {
				const tokenStart = /[A-Za-z0-9]/.test(text[index]) && (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]));
				if (!tokenStart) continue;
				compared++;
				expect(insideSpans(spans, index), JSON.stringify({ text, index })).toBe(referenceInsideUrlOrEmail(text, index));
			}
		}
		expect(compared).toBeGreaterThan(10000);
	});

	it('keeps adversarial bodies within the 8,000 character window fast', () => {
		const body = 'verification code ' + 'a1b2-'.repeat(1600);
		const started = Date.now();
		extractCodeByPattern({ subject: 'Your verification code', text: body, html: '' });
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('strips unclosed style blocks from the quick HTML window in linear time', () => {
		const html = '<p>Your verification code</p>' + '<style>x'.repeat(10000);
		const started = Date.now();
		extractCodeByPattern({ subject: 'Sign in', text: '', html });
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('still finds codes next to email addresses and links', () => {
		expect(extractCodeByPattern({
			subject: 'Verify your account',
			text: 'Hi user@example.com, your verification code is 483920. Visit https://example.com/help for help.',
			html: ''
		})).toBe('483920');
		expect(extractCodeByPattern({
			subject: 'Verify your account',
			text: 'Your verification code is https://example.com/verify?code=777123 or contact a1b2c3@example.com',
			html: ''
		})).toBe('');
	});
});
