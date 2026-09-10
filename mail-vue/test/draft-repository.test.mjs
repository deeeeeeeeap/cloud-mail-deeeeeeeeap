import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupOrphanDraftAttachments,
  clearAllDrafts,
  deleteDrafts,
  getDraftAttachments,
  getDraftForEditing,
  listDraftPage,
  saveDraft
} from '../src/db/draft-repository.js'

function cloneRows(rows) {
  return new Map([...rows].map(([key, value]) => [key, structuredClone(value)]))
}

function createMemoryDraftDb() {
  const db = {
    state: {
      draft: new Map(),
      att: new Map(),
      nextDraftId: 1
    },
    failOn: null,
    async transaction(_mode, ...args) {
      const operation = args.pop()
      const snapshot = {
        draft: cloneRows(this.state.draft),
        att: cloneRows(this.state.att),
        nextDraftId: this.state.nextDraftId
      }
      try {
        return await operation()
      } catch (error) {
        this.state = snapshot
        throw error
      }
    }
  }

  function table(name, keyName) {
    return {
      async add(value) {
        if (db.failOn === `${name}.add`) throw new Error(`injected ${name}.add failure`)
        const key = name === 'draft' ? db.state.nextDraftId++ : value[keyName]
        db.state[name].set(key, { ...structuredClone(value), [keyName]: key })
        return key
      },
      async put(value) {
        if (db.failOn === `${name}.put`) throw new Error(`injected ${name}.put failure`)
        const key = value[keyName]
        db.state[name].set(key, structuredClone(value))
        return key
      },
      async update(key, value) {
        if (db.failOn === `${name}.update`) throw new Error(`injected ${name}.update failure`)
        if (!db.state[name].has(key)) return 0
        db.state[name].set(key, { ...db.state[name].get(key), ...structuredClone(value) })
        return 1
      },
      async delete(key) {
        if (db.failOn === `${name}.delete`) throw new Error(`injected ${name}.delete failure`)
        db.state[name].delete(key)
      },
      async bulkDelete(keys) {
        if (db.failOn === `${name}.bulkDelete`) throw new Error(`injected ${name}.bulkDelete failure`)
        keys.forEach(key => db.state[name].delete(key))
      },
      async clear() {
        if (db.failOn === `${name}.clear`) throw new Error(`injected ${name}.clear failure`)
        db.state[name].clear()
      },
      async get(key) {
        return structuredClone(db.state[name].get(key))
      },
      async bulkGet(keys) {
        return keys.map(key => db.state[name].has(key)
          ? structuredClone(db.state[name].get(key))
          : undefined)
      },
      toCollection() {
        return {
          async primaryKeys() {
            return [...db.state[name].keys()]
          }
        }
      }
    }
  }

  db.draft = table('draft', 'draftId')
  db.att = table('att', 'draftId')
  return db
}

function createPagingDraftDb(rows) {
  const stats = { valueReads: [], attachmentReads: 0 }

  function collection(source) {
    let values = [...source]
    let limitSize = null
    return {
      reverse() {
        values.reverse()
        return this
      },
      limit(size) {
        limitSize = size
        return this
      },
      async toArray() {
        const result = values.slice(0, limitSize ?? values.length).map(row => structuredClone(row))
        stats.valueReads.push(result.length)
        return result
      },
      async primaryKeys() {
        return values.slice(0, limitSize ?? values.length).map(row => row.draftId)
      }
    }
  }

  return {
    stats,
    draft: {
      orderBy(key) {
        assert.equal(key, 'draftId')
        return collection([...rows].sort((a, b) => a.draftId - b.draftId))
      },
      where(key) {
        assert.equal(key, 'draftId')
        return {
          below(cursor) {
            return collection(
              rows.filter(row => row.draftId < cursor).sort((a, b) => a.draftId - b.draftId)
            )
          }
        }
      }
    },
    att: {
      async get() {
        stats.attachmentReads++
        return null
      }
    }
  }
}

test('creating a draft rolls back when its attachments cannot be stored', async () => {
  const db = createMemoryDraftDb()
  db.failOn = 'att.put'

  await assert.rejects(saveDraft(db, {
    subject: 'transactional draft',
    content: '<p>body</p>',
    receiveEmail: ['friend@example.com'],
    attachments: [{ filename: 'large.pdf', content: 'base64-data' }]
  }), /injected att\.put failure/)

  assert.equal(db.state.draft.size, 0)
  assert.equal(db.state.att.size, 0)
})

test('updating a draft rolls back both records when attachment replacement fails', async () => {
  const db = createMemoryDraftDb()
  db.state.draft.set(1, { draftId: 1, subject: 'old subject', content: 'old body' })
  db.state.att.set(1, { draftId: 1, attachments: [{ filename: 'old.txt' }] })
  db.state.nextDraftId = 2
  db.failOn = 'att.put'

  await assert.rejects(saveDraft(db, {
    draftId: 1,
    subject: 'new subject',
    content: 'new body',
    receiveEmail: [],
    attachments: [{ filename: 'new.pdf' }]
  }), /injected att\.put failure/)

  assert.equal(db.state.draft.get(1).subject, 'old subject')
  assert.deepEqual(db.state.att.get(1).attachments, [{ filename: 'old.txt' }])
})

test('deleting drafts rolls back when attachment deletion fails', async () => {
  const db = createMemoryDraftDb()
  db.state.draft.set(1, { draftId: 1, subject: 'keep until commit' })
  db.state.att.set(1, { draftId: 1, attachments: [{ filename: 'large.pdf' }] })
  db.failOn = 'att.bulkDelete'

  await assert.rejects(deleteDrafts(db, [1]), /injected att\.bulkDelete failure/)

  assert.equal(db.state.draft.has(1), true)
  assert.equal(db.state.att.has(1), true)
})

test('saving an emptied existing draft removes its attachments in the same transaction', async () => {
  const db = createMemoryDraftDb()
  db.state.draft.set(1, { draftId: 1, subject: 'old' })
  db.state.att.set(1, { draftId: 1, attachments: [{ filename: 'orphan-risk.pdf' }] })

  const result = await saveDraft(db, {
    draftId: 1,
    subject: '',
    content: '',
    receiveEmail: [],
    attachments: []
  })

  assert.equal(result, null)
  assert.equal(db.state.draft.has(1), false)
  assert.equal(db.state.att.has(1), false)
})

test('orphan cleanup deletes only attachments whose draft no longer exists', async () => {
  const db = createMemoryDraftDb()
  db.state.draft.set(1, { draftId: 1, subject: 'valid draft' })
  db.state.att.set(1, { draftId: 1, attachments: [{ filename: 'keep.pdf' }] })
  db.state.att.set(2, { draftId: 2, attachments: [{ filename: 'orphan.pdf' }] })

  const removed = await cleanupOrphanDraftAttachments(db)

  assert.equal(removed, 1)
  assert.equal(db.state.att.has(1), true)
  assert.equal(db.state.att.has(2), false)
})

test('a legacy draft without an attachment row opens with an empty attachment list', async () => {
  const db = createMemoryDraftDb()

  assert.deepEqual(await getDraftAttachments(db, 7), [])
})

test('draft pages use a stable draftId cursor and retain at most 50 lite rows', async () => {
  const rows = Array.from({length: 51}, (_, index) => ({
    draftId: index + 1,
    emailId: 9000 + index,
    subject: `draft ${index + 1}`,
    content: `<p>${'private body '.repeat(200)}</p>`,
    text: `preview ${index + 1}`,
    receiveEmail: ['friend@example.com'],
    createTime: `2026-07-18 00:00:${String(index).padStart(2, '0')}`
  }))
  const db = createPagingDraftDb(rows)

  const first = await listDraftPage(db, {size: 50})
  const second = await listDraftPage(db, {cursor: first.list.at(-1).emailId, size: 50})

  assert.deepEqual(first.list.map(row => row.draftId), Array.from({length: 50}, (_, i) => 51 - i))
  assert.equal(first.hasMore, true)
  assert.deepEqual(second.list.map(row => row.draftId), [1])
  assert.equal(second.hasMore, false)
  assert.equal(first.list.every(row => row.emailId === row.draftId), true)
  assert.equal(first.list.every(row => !('content' in row) && !('text' in row)), true)
  assert.equal(db.stats.attachmentReads, 0)
  assert.deepEqual(db.stats.valueReads, [50, 1])
})

test('opening a draft reads its full record and only its own attachments in one transaction', async () => {
  const db = createMemoryDraftDb()
  db.state.draft.set(7, {
    draftId: 7,
    emailId: 42,
    subject: 'reply draft',
    content: '<p>complete body</p>'
  })
  db.state.att.set(7, {
    draftId: 7,
    attachments: [{filename: 'only-this.pdf'}]
  })

  assert.deepEqual(await getDraftForEditing(db, 7), {
    draftId: 7,
    emailId: 42,
    subject: 'reply draft',
    content: '<p>complete body</p>',
    attachments: [{filename: 'only-this.pdf'}]
  })
  assert.equal(await getDraftForEditing(db, 8), null)
})

test('draft pagination handles empty, one-row and exact-page boundaries', async () => {
  for (const count of [0, 1, 50]) {
    const rows = Array.from({length: count}, (_, index) => ({
      draftId: index + 1,
      subject: `draft ${index + 1}`,
      text: 'preview'
    }))
    const page = await listDraftPage(createPagingDraftDb(rows), {size: 50})
    assert.equal(page.list.length, count)
    assert.equal(page.hasMore, false)
  }
})

test('clearing all drafts empties both tables in one transaction', async () => {
  const db = createMemoryDraftDb()
  await saveDraft(db, { subject: 'one', content: 'a', attachments: [{ name: 'f1' }] })
  await saveDraft(db, { subject: 'two', content: 'b', attachments: [] })
  assert.equal(db.state.draft.size, 2)
  assert.equal(db.state.att.size, 2)

  await clearAllDrafts(db)

  assert.equal(db.state.draft.size, 0)
  assert.equal(db.state.att.size, 0)
})

test('clearing all drafts rolls back when the attachment table cannot be cleared', async () => {
  const db = createMemoryDraftDb()
  await saveDraft(db, { subject: 'keep', content: 'c', attachments: [{ name: 'f2' }] })
  db.failOn = 'att.clear'

  await assert.rejects(() => clearAllDrafts(db), /injected att.clear failure/)

  assert.equal(db.state.draft.size, 1)
  assert.equal(db.state.att.size, 1)
})


test('a message containing only attachments is saved and can be reopened intact', async () => {
  const db = createMemoryDraftDb()
  const attachments = [{filename: 'important.pdf', content: 'test-only', size: 9}]
  const id = await saveDraft(db, {subject: '', content: '', receiveEmail: [], attachments})
  assert.notEqual(id, null)
  const draft = await getDraftForEditing(db, id)
  assert.deepEqual(draft.attachments, attachments)
})
