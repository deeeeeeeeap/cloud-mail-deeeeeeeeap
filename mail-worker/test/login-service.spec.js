import { beforeEach, describe, expect, it, vi } from 'vitest';
import constant from '../src/const/constant';
import KvConst from '../src/const/kv-const';
// 静态导入：动态 import 会把整条服务依赖图的加载时间算进单个用例的超时窗口，
// 多文件连跑时曾导致这里偶发 5s 超时，并连带污染下一个用例的 mockRejectedValueOnce
import loginService from '../src/service/login-service';

const mocks = vi.hoisted(() => ({
	getToken: vi.fn(),
	selectUser: vi.fn(),
	updateUserInfo: vi.fn(),
	upgradePasswordHash: vi.fn(),
	verifyPassword: vi.fn(),
	assertAllowed: vi.fn(),
	recordFailure: vi.fn(),
	releaseReservation: vi.fn(),
	clearRateLimit: vi.fn(),
	generateToken: vi.fn(),
	uuid: vi.fn()
}));

vi.mock('../src/security/user-context', () => ({
	default: {
		getToken: mocks.getToken
	}
}));

vi.mock('../src/service/user-service', () => ({
	default: {
		selectByEmailIncludeDel: mocks.selectUser,
		updateUserInfo: mocks.updateUserInfo,
		upgradePasswordHash: mocks.upgradePasswordHash
	}
}));

vi.mock('../src/utils/crypto-utils', () => ({
	default: {
		verifyPassword: mocks.verifyPassword
	}
}));

vi.mock('../src/service/auth-rate-limit-service', () => ({
	markAuthAbuse: error => Object.assign(error, { authAbuse: true }),
	default: {
		assertAllowed: mocks.assertAllowed,
		recordFailure: mocks.recordFailure,
		releaseReservation: mocks.releaseReservation,
		clear: mocks.clearRateLimit
	}
}));

vi.mock('../src/utils/jwt-utils', () => ({
	default: {
		generateToken: mocks.generateToken
	}
}));

vi.mock('uuid', () => ({
	v4: mocks.uuid
}));

describe('login service logout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectUser.mockResolvedValue({
			userId: 7,
			email: 'user@example.com',
			password: 'hash',
			salt: 'salt',
			status: 0,
			isDel: 0
		});
		mocks.updateUserInfo.mockResolvedValue();
		mocks.upgradePasswordHash.mockImplementation(async (_c, userRow) => userRow);
		mocks.verifyPassword.mockResolvedValue(true);
		mocks.assertAllowed.mockResolvedValue({ scope: 'login', identityHash: 'identity-hash' });
		mocks.recordFailure.mockResolvedValue();
		mocks.releaseReservation.mockResolvedValue();
		mocks.clearRateLimit.mockResolvedValue();
		mocks.generateToken.mockResolvedValue('jwt');
		mocks.uuid.mockReturnValue('new-session');
	});

	it('releases a reservation after a database failure without recording a bad password', async () => {
		const error = new Error('database unavailable');
		mocks.selectUser.mockRejectedValueOnce(error);
		await expect(loginService.login({ env: {} }, { email: 'user@example.com', password: 'password' })).rejects.toBe(error);
		expect(mocks.releaseReservation).toHaveBeenCalledTimes(1);
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});

	it('preserves the original error if reservation release also fails', async () => {
		const error = new Error('password upgrade unavailable');
		mocks.upgradePasswordHash.mockRejectedValueOnce(error);
		mocks.releaseReservation.mockRejectedValueOnce(new Error('release unavailable'));
		await expect(loginService.login({ env: {} }, { email: 'user@example.com', password: 'password' })).rejects.toBe(error);
		expect(mocks.releaseReservation).toHaveBeenCalledTimes(1);
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});

	it('does not release a second reservation when recording a wrong password raises 429', async () => {
		mocks.verifyPassword.mockResolvedValueOnce(false);
		mocks.recordFailure.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 429 }));
		await expect(loginService.login({ env: {} }, { email: 'user@example.com', password: 'wrong' })).rejects.toMatchObject({ code: 429 });
		expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
		expect(mocks.releaseReservation).not.toHaveBeenCalled();
	});

	it('keeps at most ten sessions when logging in', async () => {
		const existingTokens = Array.from({ length: 10 }, (_, index) => `session-${index}`);
		const put = vi.fn(async () => {});
		const c = {
			env: {
				kv: {
					get: vi.fn(async () => ({
						tokens: [...existingTokens],
						user: { userId: 7, email: 'user@example.com' }
					})),
					put
				}
			}
		};

		await loginService.login(c, { email: 'user@example.com', password: 'password' });

		const stored = JSON.parse(put.mock.calls[0][1]);
		expect(stored.tokens).toHaveLength(10);
		expect(stored.tokens).not.toContain('session-0');
		expect(stored.tokens.at(-1)).toBe('new-session');
	});

	it('does not issue a token after the authentication reservation becomes stale', async () => {
		mocks.clearRateLimit.mockRejectedValueOnce(Object.assign(new Error('stale reservation'), {
			code: 429
		}));
		const c = {
			env: {
				kv: {
					get: vi.fn(),
					put: vi.fn()
				}
			}
		};

		await expect(loginService.login(c, {
			email: 'user@example.com',
			password: 'password'
		})).rejects.toMatchObject({ code: 429 });
		expect(mocks.generateToken).not.toHaveBeenCalled();
	});

	it('removes only the current session and keeps the remaining sessions expiring', async () => {
		const authInfo = {
			tokens: ['older-session', 'current-session', 'newer-session'],
			user: { userId: 7, email: 'user@example.com' },
			refreshTime: '2026-07-10T00:00:00.000Z'
		};
		const put = vi.fn(async () => {});
		const del = vi.fn(async () => {});
		const c = {
			env: {
				kv: {
					get: vi.fn(async () => authInfo),
					put,
					delete: del
				}
			}
		};

		mocks.getToken.mockResolvedValue('current-session');

		await loginService.logout(c, 7);

		expect(put).toHaveBeenCalledWith(
			KvConst.AUTH_INFO + 7,
			JSON.stringify({
				...authInfo,
				tokens: ['older-session', 'newer-session']
			}),
			{ expirationTtl: constant.TOKEN_EXPIRE }
		);
		expect(del).not.toHaveBeenCalled();
	});

	it('deletes the auth key when the current session is the last session', async () => {
		const put = vi.fn(async () => {});
		const del = vi.fn(async () => {});
		const c = {
			env: {
				kv: {
					get: vi.fn(async () => ({
						tokens: ['only-session'],
						user: { userId: 7, email: 'user@example.com' }
					})),
					put,
					delete: del
				}
			}
		};

		mocks.getToken.mockResolvedValue('only-session');

		await loginService.logout(c, 7);

		expect(del).toHaveBeenCalledWith(KvConst.AUTH_INFO + 7);
		expect(put).not.toHaveBeenCalled();
	});

	it('treats an already missing auth key as an idempotent logout', async () => {
		const put = vi.fn(async () => {});
		const del = vi.fn(async () => {});
		const c = {
			env: {
				kv: {
					get: vi.fn(async () => null),
					put,
					delete: del
				}
			}
		};

		mocks.getToken.mockResolvedValue('already-removed-session');

		await expect(loginService.logout(c, 7)).resolves.toBeUndefined();
		expect(put).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});

	it('does not remove another session when the current token is already absent', async () => {
		const authInfo = {
			tokens: ['session-a', 'session-b'],
			user: { userId: 7, email: 'user@example.com' }
		};
		const put = vi.fn(async () => {});
		const del = vi.fn(async () => {});
		const c = {
			env: {
				kv: {
					get: vi.fn(async () => authInfo),
					put,
					delete: del
				}
			}
		};

		mocks.getToken.mockResolvedValue('already-removed-session');

		await loginService.logout(c, 7);

		expect(authInfo.tokens).toEqual(['session-a', 'session-b']);
		expect(put).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});
});
