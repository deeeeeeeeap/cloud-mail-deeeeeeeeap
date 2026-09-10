export function hasDraftContent(form = {}) {
  return Boolean(form.content || form.subject || form.receiveEmail?.length || form.attachments?.length)
}

// Async storage errors and session changes must never close/reset an unsaved
// writer. Only these explicitly named actions can discard or save content.
export async function settleDraftClose(action, { save, discard, isCurrent = () => true }) {
  if (action === 'continue') return false
  if (action === 'discard') {
    if (isCurrent()) discard()
    return true
  }
  if (action !== 'save') throw new Error('Unknown draft close action')
  await save()
  if (!isCurrent()) return false
  discard()
  return true
}
