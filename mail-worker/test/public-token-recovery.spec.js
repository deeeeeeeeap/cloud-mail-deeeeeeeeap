import { beforeEach, expect, it, vi } from 'vitest';
import publicService from '../src/service/public-service';

const mocks = vi.hoisted(() => ({
  select: vi.fn(), verify: vi.fn(), upgrade: vi.fn(), reserve: vi.fn(),
  failure: vi.fn(), release: vi.fn(), clear: vi.fn()
}));
vi.mock('../src/service/user-service', () => ({ default: { selectByEmailIncludeDel: mocks.select, upgradePasswordHash: mocks.upgrade } }));
vi.mock('../src/utils/crypto-utils', () => ({ default: { verifyPassword: mocks.verify, burnPasswordVerification: async () => false } }));
vi.mock('../src/service/auth-rate-limit-service', () => ({
  markAuthAbuse: error => Object.assign(error, { authAbuse: true }),
  default: { assertAllowed: mocks.reserve, recordFailure: mocks.failure, releaseReservation: mocks.release, clear: mocks.clear }
}));
const c = { env: { admin: 'admin@example.com' } };
const params = { email: 'admin@example.com', password: 'fixture-password' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.reserve.mockResolvedValue({ scope: 'public-gen-token', identityHash: 'fixture' });
  mocks.select.mockResolvedValue({ userId: 1, isDel: 0 });
  mocks.verify.mockResolvedValue(true);
});

it('releases infrastructure failures without counting a wrong password', async () => {
  for (const operation of [mocks.select, mocks.upgrade, mocks.clear]) {
    mocks.upgrade.mockResolvedValue({ userId: 1 });
    const error = new Error('dependency unavailable');
    operation.mockRejectedValueOnce(error);
    await expect(publicService.genToken(c, params)).rejects.toBe(error);
  }
  expect(mocks.failure).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledTimes(3);
});

it('counts actual credential failure once without releasing a second slot', async () => {
  mocks.verify.mockResolvedValueOnce(false);
  mocks.failure.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 429 }));
  await expect(publicService.genToken(c, params)).rejects.toMatchObject({ code: 429 });
  expect(mocks.failure).toHaveBeenCalledTimes(1);
  expect(mocks.release).not.toHaveBeenCalled();
});
