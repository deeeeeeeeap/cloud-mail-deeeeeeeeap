import { beforeEach, describe, expect, it, vi } from 'vitest';
import settingService from '../src/service/setting-service';

const mocks = vi.hoisted(() => ({
  row: {}, update: vi.fn(), upload: vi.fn(), remove: vi.fn()
}));
vi.mock('../src/entity/orm', () => ({
  default: () => ({
    select: () => ({ from: () => ({ get: async () => ({ ...mocks.row }) }) }),
    update: () => ({ set: values => {
      const apply = async () => { await mocks.update(values); Object.assign(mocks.row, values); return { ...mocks.row }; };
      return { run: apply, returning: () => ({ get: apply }) };
    } })
  })
}));
vi.mock('../src/service/r2-service', () => ({
  default: { storageType: async () => 'kv', putObj: (...args) => mocks.upload(...args), delete: (...args) => mocks.remove(...args) }
}));
vi.mock('../src/service/verify-record-service', () => ({ default: { selectListByIP: async () => [] } }));
vi.mock('../src/security/user-context', () => ({ default: { getUser: () => ({ email: 'admin@example.com' }) } }));

const c = {
  env: { admin: 'admin@example.com', domain: ['example.com'], kv: { put: async () => {} } },
  get: () => null, set() {}
};
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.row = { title: 'Mail', resendTokens: '{}', background: 'static/old.png' };
  await settingService.refresh(c);
});

describe('settings failure recovery', () => {
  it('rejects non-string credentials before writing settings', async () => {
    for (const value of [123, {}, [], true]) {
      await expect(settingService.set(c, { resendTokens: { 'example.com': value } })).rejects.toMatchObject({ code: 400 });
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('can read public-facing settings with legacy invalid credential values', async () => {
    mocks.row.resendTokens = JSON.stringify({ 'broken.example': 123, 'valid.example': 'fixture-token-value' });
    await settingService.refresh(c);
    const setting = await settingService.get(c, true);
    expect(setting.resendTokens).toEqual({ 'valid.example': 'fixture-toke******' });
  });

  it('preserves the current background if the new image is invalid', async () => {
    await expect(settingService.setBackground(c, { background: 'invalid-image' })).rejects.toMatchObject({ code: 400 });
    expect(mocks.row.background).toBe('static/old.png');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves the current background if upload or database update fails', async () => {
    const input = { background: 'data:image/png;base64,YQ==' };
    mocks.upload.mockRejectedValueOnce(new Error('upload failed'));
    await expect(settingService.setBackground(c, input)).rejects.toThrow('upload failed');
    expect(mocks.row.background).toBe('static/old.png');
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.update.mockRejectedValueOnce(new Error('database failed'));
    await expect(settingService.setBackground(c, input)).rejects.toThrow('database failed');
    expect(mocks.row.background).toBe('static/old.png');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('switches the background before cleanup and does not delete a reused key', async () => {
    const next = await settingService.setBackground(c, { background: 'data:image/png;base64,YQ==' });
    expect(mocks.row.background).toBe(next);
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]);
    expect(mocks.remove).toHaveBeenCalledWith(c, 'static/old.png');
    mocks.remove.mockClear();
    await settingService.setBackground(c, { background: 'data:image/png;base64,YQ==' });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not report a committed background change as failed when old-object cleanup fails', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(settingService.setBackground(c, { background: 'https://example.com/new.png' })).resolves.toBe('https://example.com/new.png');
    expect(mocks.row.background).toBe('https://example.com/new.png');
  });
});
