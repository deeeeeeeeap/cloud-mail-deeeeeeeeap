import { describe, expect, it, vi } from 'vitest';

import aiService, { extractCodeByPattern } from '../src/service/ai-service';
import { settingConst } from '../src/const/entity-const';

describe('ai service code extraction', () => {
	it('extracts a simple signup code from a generic verification email', () => {
		const code = extractCodeByPattern({
			subject: 'Your Notion signup code',
			text: '922951\n'
		});

		expect(code).toBe('922951');
	});

	it('normalizes separated one-time codes', () => {
		const code = extractCodeByPattern({
			subject: 'Your verification code',
			text: 'Use verification code 123-456 to continue.'
		});

		expect(code).toBe('123456');
	});

	it('extracts alphanumeric verification codes near an explicit code label', () => {
		const code = extractCodeByPattern({
			subject: 'Your sign-in verification code',
			text: 'Enter verification code AB12CD to continue.'
		});

		expect(code).toBe('AB12CD');
	});

	it('does not extract unrelated numbers without a verification hint', () => {
		const code = extractCodeByPattern({
			subject: 'Your invoice is ready',
			text: 'Invoice 20260518 total is 19.99.'
		});

		expect(code).toBe('');
	});

	it('does not extract dates or browser versions from login security notices', () => {
		const code = extractCodeByPattern({
			subject: 'Security alert: new login from Windows',
			text: 'We noticed a sign-in from IP 192.168.1.18 on 2026-05-18 using Chrome 126.0.0.1. If this was you, ignore this email.'
		});

		expect(code).toBe('');
	});

	it('does not extract reference or order ids as verification codes', () => {
		const code = extractCodeByPattern({
			subject: 'Your security settings changed',
			text: 'Reference ID: AB12CD34. If this was you, no further action is required.'
		});

		expect(code).toBe('');
	});

	it('does not extract generic promo codes', () => {
		const code = extractCodeByPattern({
			subject: 'Weekend discount',
			text: 'Use promo code AB12CD at checkout before Monday.'
		});

		expect(code).toBe('');
	});

	it('uses the local parser before calling Workers AI', async () => {
		const ai = { run: vi.fn() };
		const code = await aiService.extractCode({
			env: { ai }
		}, {
			subject: 'Your login code',
			text: '841205'
		}, {
			aiCode: settingConst.aiCode.OPEN,
			aiCodeFilter: ''
		});

		expect(code).toBe('841205');
		expect(ai.run).not.toHaveBeenCalled();
	});

	it('does not call Workers AI when the AI fallback setting is closed', async () => {
		const ai = { run: vi.fn() };
		const code = await aiService.extractCode({
			env: { ai }
		}, {
			subject: 'Unusual verification message',
			text: 'Please continue in your browser.'
		}, {
			aiCode: settingConst.aiCode.CLOSE,
			aiCodeFilter: ''
		});

		expect(code).toBe('');
		expect(ai.run).not.toHaveBeenCalled();
	});
});
