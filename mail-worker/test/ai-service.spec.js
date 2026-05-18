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

	it('does not extract unrelated numbers without a verification hint', () => {
		const code = extractCodeByPattern({
			subject: 'Your invoice is ready',
			text: 'Invoice 20260518 total is 19.99.'
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
