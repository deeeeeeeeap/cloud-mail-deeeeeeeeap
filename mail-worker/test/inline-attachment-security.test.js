import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectInlineAttachment, inlineAttachmentResponse } from '../src/service/inline-attachment-service';
import r2Service from '../src/service/r2-service';

vi.mock('../src/service/r2-service', () => ({ default: { getObj: vi.fn(), toResponse: vi.fn() } }));
const params = { emailId: 100, key: 'attachments/sample.png' };
const c = { env };

beforeAll(async () => {
  await env.db.exec('CREATE TABLE IF NOT EXISTS email (email_id INTEGER PRIMARY KEY, user_id INTEGER, status INTEGER, is_del INTEGER);');
  await env.db.exec('CREATE TABLE IF NOT EXISTS attachments (att_id INTEGER PRIMARY KEY, email_id INTEGER, user_id INTEGER, key TEXT, type INTEGER, status INTEGER, mime_type TEXT);');
});
beforeEach(async () => {
  await env.db.exec('DELETE FROM attachments; DELETE FROM email;');
  await env.db.prepare('INSERT INTO email (email_id,user_id,status,is_del) VALUES (100,1,0,0)').run();
  await env.db.prepare('INSERT INTO attachments (att_id,email_id,user_id,key,type,status,mime_type) VALUES (10,100,1,?,1,0,?)').bind(params.key, 'image/png').run();
  vi.clearAllMocks();
});

describe('inline attachment authorization uses real local D1 queries', () => {
  it('permits the owner of the exact ready mail', async () => {
    expect(await selectInlineAttachment(c, params, 1)).toMatchObject({ key: params.key, mimeType: 'image/png' });
  });
  it('denies another user, absent identity and another message', async () => {
    await expect(selectInlineAttachment(c, params, 2)).rejects.toThrow('Attachment not found');
    await expect(selectInlineAttachment(c, params, undefined)).rejects.toThrow('Attachment not found');
    await expect(selectInlineAttachment(c, { ...params, emailId: 101 }, 1)).rejects.toThrow('Attachment not found');
  });
  it('does not interpret absent ownership as administrator authority', async () => {
    await expect(selectInlineAttachment(c, params, null)).rejects.toThrow('Attachment not found');
    expect(await selectInlineAttachment(c, params, undefined, { allMail: true })).toMatchObject({ key: params.key });
  });
  it('revokes ordinary-reader access after logical deletion', async () => {
    await env.db.prepare('UPDATE email SET is_del = 1 WHERE email_id = 100').run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
    expect(await selectInlineAttachment(c, params, undefined, { allMail: true })).toMatchObject({ key: params.key });
  });
  it.each([6, 8])('denies incomplete parent state %s even for admin', async status => {
    await env.db.prepare('UPDATE email SET status = ? WHERE email_id = 100').bind(status).run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
    await expect(selectInlineAttachment(c, params, undefined, { allMail: true })).rejects.toThrow('Attachment not found');
  });
  it.each([1, 2, 3])('denies non-ready attachment state %s', async status => {
    await env.db.prepare('UPDATE attachments SET status = ? WHERE att_id = 10').bind(status).run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
  });
  it('denies SVG, regular attachments, missing parents and inconsistent owners', async () => {
    await env.db.prepare("UPDATE attachments SET mime_type = 'image/svg+xml' WHERE att_id = 10").run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
    await env.db.prepare("UPDATE attachments SET mime_type = 'image/png', type = 0 WHERE att_id = 10").run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
    await env.db.prepare('UPDATE attachments SET type = 1, user_id = 2 WHERE att_id = 10').run();
    await expect(selectInlineAttachment(c, params, 1)).rejects.toThrow('Attachment not found');
    await env.db.exec('DELETE FROM email;');
    await expect(selectInlineAttachment(c, params, undefined, { allMail: true })).rejects.toThrow('Attachment not found');
  });
  it('rejects path traversal and invalid identifiers before querying storage', async () => {
    for (const key of ['attachments/../x', 'attachments/a%2fb', 'static/x', 'attachments/a?token=x']) {
      await expect(selectInlineAttachment(c, { ...params, key }, 1)).rejects.toThrow('Attachment not found');
    }
    expect(r2Service.getObj).not.toHaveBeenCalled();
  });
  it('uses a private non-cacheable response with a fixed image type', async () => {
    r2Service.getObj.mockResolvedValue(new Uint8Array([1]));
    r2Service.toResponse.mockImplementation((obj, headers) => new Response(obj, { headers }));
    const response = await inlineAttachmentResponse(c, params, 1);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(response.headers.get('Content-Type')).toBe('image/png');
  });
});
