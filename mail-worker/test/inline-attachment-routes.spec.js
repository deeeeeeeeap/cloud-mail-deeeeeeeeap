import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';

vi.mock('../src/utils/jwt-utils', () => ({ default: {
  verifyToken: vi.fn(async (_c, jwt) => jwt === 'valid-session' ? { userId: 11, token: 'opaque-session' } : null)
} }));
vi.mock('../src/security/auth-info-cache', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/service/perm-service', () => ({ default: { userPermKeys: vi.fn() } }));
vi.mock('../src/service/inline-attachment-service', () => ({ inlineAttachmentResponse: vi.fn() }));

import authInfoCache from '../src/security/auth-info-cache';
import permService from '../src/service/perm-service';
import { inlineAttachmentResponse } from '../src/service/inline-attachment-service';
import worker from '../src/index';

beforeEach(() => {
  vi.clearAllMocks();
  authInfoCache.get.mockResolvedValue({
    user: { userId: 11, email: 'reader@example.com' },
    tokens: ['opaque-session'], refreshTime: new Date().toISOString()
  });
  permService.userPermKeys.mockResolvedValue([]);
  inlineAttachmentResponse.mockImplementation(async () => new Response('authorized-image', { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' } }));
});

async function request(path, token) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://example.com/api${path}`, {
    headers: token ? { Authorization: token } : {}
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const params = '?emailId=100&key=attachments%2Fsample.png';

describe('inline attachment route authentication and permission wiring', () => {
  it.each(['/email/attachment/inline', '/allEmail/attachment/inline'])('rejects anonymous and malformed sessions at %s', async path => {
    expect((await request(path + params)).status).toBe(401);
    expect((await request(path + params, 'invalid-session')).status).toBe(401);
    expect(inlineAttachmentResponse).not.toHaveBeenCalled();
  });
  it('ordinary readers cannot promote scope through a query parameter', async () => {
    expect((await request('/email/attachment/inline' + params + '&scope=all', 'valid-session')).status).toBe(200);
    const args = inlineAttachmentResponse.mock.calls[0];
    expect(args[2]).toBe(11);
    expect(args[3]).toBeUndefined();
  });
  it('requires all-email:query for the administrative inline route', async () => {
    expect((await request('/allEmail/attachment/inline' + params, 'valid-session')).status).toBe(403);
    expect(inlineAttachmentResponse).not.toHaveBeenCalled();
  });
  it('allows specifically permitted all-mail readers and passes explicit admin scope', async () => {
    permService.userPermKeys.mockResolvedValue(['all-email:query']);
    const response = await request('/allEmail/attachment/inline' + params, 'valid-session');
    expect(response.status).toBe(200);
    expect(inlineAttachmentResponse.mock.calls[0][2]).toBeUndefined();
    expect(inlineAttachmentResponse.mock.calls[0][3]).toEqual({ allMail: true });
  });
  it('rejects a signed session that is no longer present in the active session list', async () => {
    authInfoCache.get.mockResolvedValue({ user: { userId: 11 }, tokens: [], refreshTime: new Date().toISOString() });
    expect((await request('/email/attachment/inline' + params, 'valid-session')).status).toBe(401);
    expect(inlineAttachmentResponse).not.toHaveBeenCalled();
  });
});
