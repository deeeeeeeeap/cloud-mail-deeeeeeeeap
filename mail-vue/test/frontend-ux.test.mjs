import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createVisiblePoller} from '../src/utils/visible-poller.js'
import {createBreakpointTransition} from '../src/layout/responsive-navigation.js'
import {hasDraftContent, settleDraftClose} from '../src/layout/write/close-state.js'
import zh from '../src/i18n/zh.js'
import en from '../src/i18n/en.js'
import tw from '../src/i18n/zh-tw.js'
import ja from '../src/i18n/ja.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function polling(run) {
  const timers = new Map()
  const listeners = new Set()
  let id = 0
  const document = {hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn)}
  const poller = createVisiblePoller({run, document, intervalMs: 10, maxDelayMs: 40,
    setTimeout: (fn, delay) => {timers.set(++id, {fn, delay}); return id}, clearTimeout: id => timers.delete(id)})
  return {...poller, timers, listeners,
    hide(value) {document.hidden = value; for (const fn of listeners) fn()},
    tick() {const [id, task] = timers.entries().next().value; timers.delete(id); task.fn()}
  }
}

test('waiting is opt-in and never overlaps a pending request', async () => {
  let resolve
  let calls = 0
  const state = polling(() => {calls++; return new Promise(done => {resolve = done})})
  assert.equal(calls, 0)
  state.start(); state.start()
  assert.equal(calls, 1)
  assert.equal(state.timers.size, 0)
  resolve(true); await settle()
  assert.equal(state.timers.size, 1)
  assert.equal(state.timers.values().next().value.delay, 10)
  state.dispose()
  assert.equal(state.timers.size, 0)
  assert.equal(state.listeners.size, 0)
})

test('visibility cancels work, resumes once, and ignores late aborted completions', async () => {
  const requests = []
  const state = polling(signal => new Promise(resolve => requests.push({signal, resolve})))
  state.start()
  state.hide(true)
  assert.equal(requests[0].signal.aborted, true)
  state.hide(false)
  assert.equal(requests.length, 2)
  requests[0].resolve(true); await settle()
  assert.equal(state.timers.size, 0)
  requests[1].resolve(true); await settle()
  assert.equal(state.timers.size, 1)
  state.stop()
  state.hide(true); state.hide(false)
  assert.equal(requests.length, 2)
  state.dispose(); state.start()
  assert.equal(requests.length, 2)
})

test('failed checks back off with a ceiling, successful checks reset the delay', async () => {
  let success = false
  const state = polling(async () => success)
  state.start(); await settle()
  assert.equal(state.timers.values().next().value.delay, 20)
  state.tick(); await settle()
  assert.equal(state.timers.values().next().value.delay, 40)
  state.tick(); await settle()
  assert.equal(state.timers.values().next().value.delay, 40)
  success = true
  state.tick(); await settle()
  assert.equal(state.timers.values().next().value.delay, 10)
  state.dispose()
})

test('hidden pages do not request even when waiting is enabled', async () => {
  let calls = 0
  const state = polling(async () => {calls++})
  state.hide(true); state.start(); await settle()
  assert.equal(calls, 0)
  state.hide(false); await settle()
  assert.equal(calls, 1)
  state.dispose()
})

test('resizing within a layout mode preserves user sidebar state', () => {
  const changes = []
  const resize = createBreakpointTransition(mobile => changes.push(mobile))
  resize(1440); resize(1400); resize(1200)
  assert.deepEqual(changes, [false])
  resize(1024); resize(768); resize(390)
  assert.deepEqual(changes, [false, true])
  resize(1025)
  assert.deepEqual(changes, [false, true, false])
})

test('attachment-only messages count as unsaved work', () => {
  assert.equal(hasDraftContent({}), false)
  assert.equal(hasDraftContent({attachments: [{filename: 'important.pdf'}]}), true)
  assert.equal(hasDraftContent({receiveEmail: ['hello@example.com']}), true)
})

test('keep editing does not save, close, or reset', async () => {
  let saved = false, discarded = false
  assert.equal(await settleDraftClose('continue', {save: () => {saved = true}, discard: () => {discarded = true}}), false)
  assert.equal(saved, false); assert.equal(discarded, false)
})

test('discard is explicit and saving must succeed before closing', async () => {
  const events = []
  await settleDraftClose('discard', {discard: () => events.push('discard')})
  await settleDraftClose('save', {save: async () => events.push('save'), discard: () => events.push('close')})
  assert.deepEqual(events, ['discard', 'save', 'close'])
})

test('storage failure preserves the open writer and unsaved content', async () => {
  let closed = false
  await assert.rejects(settleDraftClose('save', {save: async () => {throw new Error('quota')}, discard: () => {closed = true}}), /quota/)
  assert.equal(closed, false)
})

test('late draft saves cannot reset a new session or writer', async () => {
  let current = true, closed = false
  await settleDraftClose('save', {save: async () => {current = false}, isCurrent: () => current, discard: () => {closed = true}})
  assert.equal(closed, false)
})

test('new UX strings exist in every supported language with matching placeholders', () => {
  for (const locale of [en, tw, ja]) {
    assert.deepEqual(Object.keys(locale.ux).sort(), Object.keys(zh.ux).sort())
    for (const key of Object.keys(zh.ux)) {
      assert.equal(typeof locale.ux[key], 'string')
      assert.deepEqual((locale.ux[key].match(/\{\w+\}/g) || []).sort(), (zh.ux[key].match(/\{\w+\}/g) || []).sort())
    }
  }
})

test('code cards have distinct controls and never imply true OTP validity', () => {
  const source = readFileSync(new URL('../src/views/code-center/index.vue', import.meta.url), 'utf8')
  assert.match(source, /<article class="code-card"/)
  assert.doesNotMatch(source, /role="button"|t\('codeExpiresIn'/)
  assert.match(source, /noMsg: true/)
  assert.match(source, /poller\.dispose\(\)/)
})

test('editor failures are visible and retryable; close actions are explicit', () => {
  const editor = readFileSync(new URL('../src/components/tiny-editor/index.vue', import.meta.url), 'utf8')
  const writer = readFileSync(new URL('../src/layout/write/index.vue', import.meta.url), 'utf8')
  assert.match(editor, /v-if="loadFailed"/)
  assert.match(editor, /@click="initTinyMCE"/)
  for (const action of ['continue', 'save', 'discard']) assert.ok(writer.includes(`resolveClose('${action}')`))
  assert.doesNotMatch(writer, /action === 'cancel'/)
  assert.match(writer, /focusKeepEditing/)
})
