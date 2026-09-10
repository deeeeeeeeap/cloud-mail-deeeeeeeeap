import BizError from '../error/biz-error';
import r2Service from './r2-service';
import { attConst, emailConst, isDel } from '../const/entity-const';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);
const notFound = () => new BizError('Attachment not found', 404);

// This query ties the object to the requested mail, not merely to a content hash.
// A missing owner is NEVER interpreted as administrator access.
export async function selectInlineAttachment(c, params, userId, { allMail = false } = {}) {
  const emailId = Number(params.emailId);
  const key = String(params.key || '');
  if (!Number.isSafeInteger(emailId) || emailId <= 0 || !/^attachments\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(key)) throw notFound();
  if (!allMail && (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0)) throw notFound();
  const filters = ['a.email_id = ?', 'a.key = ?', 'a.type = ?', 'a.status = ?', 'e.status NOT IN (?, ?)'];
  const bindings = [emailId, key, attConst.type.EMBED, attConst.status.READY, emailConst.status.SAVING, emailConst.status.FAILED];
  if (!allMail) {
    filters.push('a.user_id = ?', 'e.user_id = ?', 'e.is_del = ?');
    bindings.push(userId, userId, isDel.NORMAL);
  }
  // allMail is only used by /allEmail/attachment/inline, guarded by all-email:query.
  // Admin access to logically deleted mail matches the existing all-mail reader.
  const row = await c.env.db.prepare(`
    SELECT a.key, a.mime_type AS mimeType
    FROM attachments a JOIN email e ON e.email_id = a.email_id
    WHERE ${filters.join(' AND ')} LIMIT 1
  `).bind(...bindings).first();
  if (!row || !IMAGE_TYPES.has(String(row.mimeType || '').split(';')[0].trim().toLowerCase())) throw notFound();
  return row;
}

export async function inlineAttachmentResponse(c, params, userId, options = {}) {
  const row = await selectInlineAttachment(c, params, userId, options);
  const obj = await r2Service.getObj(c, row.key);
  const response = r2Service.toResponse(obj, {
    'Content-Type': row.mimeType.split(';')[0].trim().toLowerCase(),
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store, max-age=0',
    'Vary': 'Authorization',
    'X-Content-Type-Options': 'nosniff'
  });
  if (!response) throw notFound();
  return response;
}
