import { afterEach, describe, expect, it, vi } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';

describe('jwt utils', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('adds exp when a TTL is supplied and rejects expired tokens', async () => {
		const c = { env: { jwt_secret: 'test-secret' } };
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));

		const token = await jwtUtils.generateToken(c, { emailId: 123 }, 60);
		const payload = await jwtUtils.verifyToken(c, token);

		expect(payload.emailId).toBe(123);
		expect(payload.exp - payload.iat).toBe(60);

		vi.setSystemTime(new Date('2026-06-08T00:01:01Z'));
		await expect(jwtUtils.verifyToken(c, token)).resolves.toBeNull();
	});
});
