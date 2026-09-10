import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {computed, reactive, ref, watch} from 'vue'

const source = readFileSync(new URL('../src/views/code-center/index.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[^\n]+\r?$/gm, '')
const settle = () => new Promise(resolve => setImmediate(resolve))
const row = (emailId, seconds = 90) => ({emailId, code: '483920', expiresInSeconds: seconds})

function setup(request) {
  let now = 1000000
  let unmount
  const timers = new Map()
  const listeners = new Map()
  const clipboard = []
  let timerId = 0
  const document = {
    hidden: false,
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event)
  }
  const adapters = {
    createVisiblePoller: () => ({start() {}, stop() {}, dispose() {}}), AbortController,
    computed, reactive, ref, watch, defineOptions() {}, onBeforeUnmount(fn) {unmount = fn},
    useI18n: () => ({t: (key, values) => values ? `${key}:${values.minutes}` : key}),
    useEmailStore: () => ({}), hasPerm: () => true, ElMessage() {},
    codeList: params => request('mine', params), codeAllList: params => request('all', params),
    Date: {now: () => now}, document, formatShortDateTime: time => time,
    navigator: {clipboard: {writeText: async text => clipboard.push(text)}},
    window: {setTimeout: (fn, delay) => {timers.set(++timerId, {fn, at: now + delay}); return timerId}},
    clearTimeout: id => timers.delete(id)
  }
  const state = new Function(...Object.keys(adapters), `${source}
    return {refresh, loadMore, copyCode, codes, scope, params, first, loading, loadingMore, hasMore, displayCode, codeStatusText, waiting, pollForCodes, newCodeCount, backgroundFailed};`
  )(...Object.values(adapters))
  return {...state, clipboard, timers, listeners, document,
    unmount: () => unmount(),
    advance(ms, runTimers = true) {
      now += ms
      if (runTimers) for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {timers.delete(id); timer.fn()}
      }
    }
  }
}

test('a failed first load ends loading and can be retried', async () => {
  let attempts = 0
  const state = setup(async () => {
    if (++attempts === 1) throw new Error('unavailable')
    return {list: [row(3)], hasMore: false}
  })
  await settle()
  assert.equal(state.first.value, false)
  assert.equal(state.loading.value, false)
  await state.refresh()
  assert.equal(state.codes[0].emailId, 3)
})

test('failed refresh preserves pagination and load-more uses the last submitted query', async () => {
  const calls = []
  let fail = false
  const state = setup(async (scope, params) => {
    calls.push(params)
    if (fail) throw new Error('unavailable')
    return {list: [row(params.emailId ? 2 : 3)], hasMore: true}
  })
  await settle()
  fail = true
  await state.refresh()
  assert.equal(state.hasMore.value, true)
  assert.equal(state.codes.length, 1)
  fail = false
  state.params.query = 'not submitted'
  await state.loadMore()
  assert.equal(calls.at(-1).query, '')
  assert.equal(calls.at(-1).emailId, 3)
  assert.deepEqual(state.codes.map(item => item.emailId), [3, 2])
})

test('scope changes clear the old list and ignore responses from the previous scope', async () => {
  const pending = []
  const state = setup((scope) => new Promise((resolve, reject) => pending.push({scope, resolve, reject})))
  pending[0].resolve({list: [row(3)], hasMore: true})
  await settle()
  const oldRefresh = state.refresh()
  state.scope.value = 'all'
  const newRefresh = state.refresh()
  assert.equal(state.codes.length, 0)
  pending[1].resolve({list: [row(2)], hasMore: true})
  pending[2].reject(new Error('unavailable'))
  await Promise.all([oldRefresh, newRefresh])
  assert.equal(state.codes.length, 0)
  assert.equal(state.loading.value, false)
})

test('display-window hiding updates locally and expired values cannot be copied even before a delayed timer runs', async () => {
  const state = setup(async () => ({list: [row(3)], hasMore: false}))
  await settle()
  assert.equal(state.codeStatusText(state.codes[0]), 'ux.codeRecent')
  state.advance(30000)
  assert.equal(state.codeStatusText(state.codes[0]), 'ux.codeRecent')
  await state.copyCode(state.codes[0])
  assert.deepEqual(state.clipboard, ['483920'])
  state.advance(60000, false)
  await state.copyCode(state.codes[0])
  assert.deepEqual(state.clipboard, ['483920'])
  assert.equal(state.codes[0].code, '')
  assert.equal(state.displayCode(state.codes[0]), 'ux.codeHiddenValue')
  state.unmount()
  assert.equal(state.timers.size, 0)
  assert.equal(state.listeners.size, 0)
})

test('network delay is deducted and visibility resume expires codes without another request', async () => {
  let resolve
  let requests = 0
  const state = setup(() => {requests++; return new Promise(done => {resolve = done})})
  state.advance(10000)
  resolve({list: [row(3, 20)], hasMore: false})
  await settle()
  state.document.hidden = true
  state.listeners.get('visibilitychange')()
  assert.equal(state.timers.size, 0)
  state.advance(10000)
  state.document.hidden = false
  state.listeners.get('visibilitychange')()
  assert.equal(state.codes[0].isStale, true)
  assert.equal(requests, 1)
})

test('duplicate pending refreshes are ignored and unmounted requests cannot update state', async () => {
  let resolve
  let requests = 0
  const state = setup(() => {requests++; return new Promise(done => {resolve = done})})
  state.refresh()
  assert.equal(requests, 1)
  state.unmount()
  resolve({list: [row(3)], hasMore: false})
  await settle()
  assert.equal(state.codes.length, 0)
  assert.equal(state.timers.size, 0)
})


test('background checks announce new IDs without reordering cards or using unsubmitted search text', async () => {
  const calls = []
  let latest = 3
  const state = setup(async (scope, params) => {
    calls.push({scope, params})
    return {list: [row(latest)], hasMore: true}
  })
  await settle()
  latest = 4
  state.params.query = 'half typed'
  await state.pollForCodes(new AbortController().signal)
  assert.equal(calls.at(-1).params.query, '')
  assert.equal(state.newCodeCount.value, 1)
  assert.deepEqual(state.codes.map(item => item.emailId), [3])
  state.unmount()
})

test('a stopped background request cannot publish new-code counts', async () => {
  let resolve
  let calls = 0
  const state = setup(async () => ++calls === 1 ? {list: [row(3)]} : new Promise(done => {resolve = done}))
  await settle()
  const controller = new AbortController()
  const task = state.pollForCodes(controller.signal)
  controller.abort()
  resolve({list: [row(4)]})
  await task
  assert.equal(state.newCodeCount.value, 0)
  state.unmount()
})

test('background failures preserve cards and show retry state instead of success', async () => {
  let calls = 0
  const state = setup(async () => {
    if (++calls > 1) throw new Error('offline')
    return {list: [row(3)]}
  })
  await settle()
  assert.equal(await state.pollForCodes(new AbortController().signal), false)
  assert.equal(state.backgroundFailed.value, true)
  assert.equal(state.codes[0].emailId, 3)
  state.unmount()
})
