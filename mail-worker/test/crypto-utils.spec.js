import { describe, expect, it, vi } from 'vitest';
import cryptoUtils from '../src/utils/crypto-utils';

describe('crypto utils', () => {
	it('generates random passwords with the expected length and character set', () => {
		const password = cryptoUtils.genRandomPwd();
		const longerPassword = cryptoUtils.genRandomPwd(16);

		expect(password).toHaveLength(8);
		expect(longerPassword).toHaveLength(16);
		expect(password).toMatch(/^[A-Za-z0-9]+$/);
		expect(longerPassword).toMatch(/^[A-Za-z0-9]+$/);
	});

	it('does not depend on Math.random for generated passwords', () => {
		const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
			throw new Error('Math.random should not be used');
		});

		try {
			expect(cryptoUtils.genRandomPwd()).toMatch(/^[A-Za-z0-9]{8}$/);
		} finally {
			randomSpy.mockRestore();
		}
	});
});
