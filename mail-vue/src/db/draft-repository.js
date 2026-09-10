export async function saveDraft(database, draftInput) {
  const {
    draftId = null,
    attachments = [],
    ...draft
  } = draftInput

  const meaningful = Boolean(draft.content || draft.subject || attachments.length)
    || (Array.isArray(draft.receiveEmail) && draft.receiveEmail.length > 0)
  if (!meaningful) {
    if (draftId !== null && draftId !== undefined) {
      await deleteDrafts(database, [draftId])
    }
    return null
  }

  return database.transaction('rw', database.draft, database.att, async () => {
    if (draftId !== null && draftId !== undefined) {
      const updated = await database.draft.update(draftId, draft)
      if (updated !== 1) {
        throw new Error('draft no longer exists')
      }
      await database.att.put({ draftId, attachments })
      return draftId
    }

    const newDraftId = await database.draft.add(draft)
    await database.att.put({ draftId: newDraftId, attachments })
    return newDraftId
  })
}

export async function deleteDrafts(database, draftIds) {
  const ids = [...new Set(draftIds)].filter(id => id !== null && id !== undefined)
  if (ids.length === 0) return

  await database.transaction('rw', database.draft, database.att, async () => {
    await database.draft.bulkDelete(ids)
    await database.att.bulkDelete(ids)
  })
}

export async function cleanupOrphanDraftAttachments(database) {
  return database.transaction('rw', database.draft, database.att, async () => {
    const attachmentDraftIds = await database.att.toCollection().primaryKeys()
    if (attachmentDraftIds.length === 0) return 0

    const drafts = await database.draft.bulkGet(attachmentDraftIds)
    const orphanIds = attachmentDraftIds.filter((_draftId, index) => !drafts[index])
    if (orphanIds.length > 0) {
      await database.att.bulkDelete(orphanIds)
    }
    return orphanIds.length
  })
}

export async function getDraftAttachments(database, draftId) {
  return database.transaction('r', database.att, async () => {
    const attachmentRow = await database.att.get(draftId)
    return Array.isArray(attachmentRow?.attachments) ? attachmentRow.attachments : []
  })
}

export async function getDraftForEditing(database, draftId) {
  return database.transaction('r', database.draft, database.att, async () => {
    const [draft, attachmentRow] = await Promise.all([
      database.draft.get(draftId),
      database.att.get(draftId)
    ])
    if (!draft) return null
    return {
      ...draft,
      attachments: Array.isArray(attachmentRow?.attachments)
        ? attachmentRow.attachments
        : []
    }
  })
}

function draftPreview(draft) {
  const source = draft.text || String(draft.content || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  return String(source).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function toDraftListItem(draft) {
  return {
    draftId: draft.draftId,
    // email-scroll uses emailId as its stable row key and continuation cursor.
    emailId: draft.draftId,
    receiveEmail: Array.isArray(draft.receiveEmail) ? [...draft.receiveEmail] : [],
    subject: draft.subject || '',
    createTime: draft.createTime,
    previewText: draftPreview(draft)
  }
}

export async function listDraftPage(database, {cursor = 0, size = 50} = {}) {
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(size, 10) || 50))
  const draftCursor = Number.parseInt(cursor, 10) || 0
  const collection = draftCursor > 0
    ? database.draft.where('draftId').below(draftCursor).reverse()
    : database.draft.orderBy('draftId').reverse()
  const rows = await collection.limit(pageSize).toArray()

  let hasMore = false
  if (rows.length === pageSize) {
    const lastDraftId = rows.at(-1)?.draftId
    if (lastDraftId !== undefined) {
      const remainingKeys = await database.draft
        .where('draftId')
        .below(lastDraftId)
        .limit(1)
        .primaryKeys()
      hasMore = remainingKeys.length > 0
    }
  }

  return {
    list: rows.map(toDraftListItem),
    hasMore
  }
}

// 用户在设置页主动清空本地草稿（保留数据库本身，注销流程不会调用此函数）
export async function clearAllDrafts(database) {
  return database.transaction('rw', database.draft, database.att, async () => {
    await database.draft.clear()
    await database.att.clear()
  })
}
