// Persist navigation identity, not a blacklist of today's sensitive fields.
// New API fields must never silently become persistent browser history.
export function safeEmailCache(state = {}) {
  const data = state?.contentData || {};
  const source = data.email;
  let email = null;
  if (source && Number.isSafeInteger(Number(source.emailId)) && Number(source.emailId) > 0) {
    email = {};
    for (const key of ['emailId', 'accountId', 'type', 'status', 'unread', 'isStar']) {
      if (source[key] !== undefined) email[key] = source[key];
    }
  }
  return { contentData: {
    email,
    delType: data.delType === 'physics' ? 'physics' : 'logic',
    showStar: data.showStar !== false,
    showReply: data.showReply !== false,
    showUnread: data.showUnread === true
  } };
}

export function deserializeEmailCache(raw) {
  try { return safeEmailCache(JSON.parse(raw)); }
  catch { return safeEmailCache(); }
}
