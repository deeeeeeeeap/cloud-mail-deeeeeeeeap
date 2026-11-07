import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import * as Vue from 'vue'
import {createActiveTask} from '../src/utils/active-task.js'
import {createPollBackoff, trackUserActivity} from '../src/utils/poll-backoff.js'

const source = readFileSync(new URL('../src/views/email/index.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?\sfrom\s+['"][^'"]+['"];?\r?$/gm, '')
const settle = () => new Promise(resolve => setImmediate(resolve))

function fakeClock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimeout(callback, delay) {
      timers.set(++nextId, {callback, at: time + delay})
      return nextId
    },
    clearTimeout: id => timers.delete(id),
    async advance(ms) {
      const target = time + ms
      await settle()
      for (;;) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? []
        if (!timer || timer.at > target) break
        time = timer.at
        timers.delete(id)
        timer.callback()
        await settle()
      }
      time = target
      await settle()
    }
  }
}

function eventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type) },
    dispatch: type => listeners.get(type)?.({type})
  }
}

function mountInbox() {
  const clock = fakeClock()
  const window = eventTarget()
  const document = {...eventTarget(), hidden: false}
  const polls = []
  const added = []
  const responses = []
  const hooks = {}
  const adapters = {
    defineOptions() {}, ref: Vue.ref, reactive: Vue.reactive, watch: Vue.watch,
    onMounted() {}, onActivated: fn => { hooks.activated = fn }, onDeactivated: fn => { hooks.deactivated = fn },
    onUnmounted: fn => { hooks.unmounted = fn },
    useRoute: () => ({name: 'email'}), router: {push() {}},
    useEmailStore: () => ({}),
    useAccountStore: () => ({currentAccountId: 1, currentAccount: {allReceive: 0}}),
    useSettingStore: () => ({settings: {autoRefresh: 3}}),
    createActiveTask,
    waitUntilVisible: async signal => !signal.aborted,
    sleepUntil: async (ms, signal) => !signal?.aborted,
    createPollBackoff: options => createPollBackoff({...options, ...clock, hasFocus: () => true}),
    trackUserActivity: callback => trackUserActivity(callback, {window, document}),
    emailLatest: async latestId => {
      polls.push({at: clock.now(), latestId})
      return responses.shift() ?? []
    }
  }
  const {scroll} = new Function(...Object.keys(adapters), `${source}\nreturn {scroll}`)(...Object.values(adapters))
  scroll.value = {
    firstLoad: false,
    latestEmail: {emailId: 10, reqAccountId: 1, allReceive: 0},
    addItem: email => added.push(email.emailId)
  }
  return {clock, window, polls, added, responses, hooks}
}

test('the inbox polls at the configured interval, backs off when idle and resumes on activity or new mail', async () => {
  const inbox = mountInbox()
  inbox.hooks.activated()
  await inbox.clock.advance(120000)
  assert.equal(inbox.polls.length, 40, 'every 3 seconds during the first two minutes')

  await inbox.clock.advance(180000)
  assert.deepEqual(inbox.polls.slice(40).map(poll => poll.at), [126000, 138000, 162000, 192000, 222000, 252000, 282000])

  inbox.window.dispatch('pointerdown')
  await inbox.clock.advance(0)
  assert.equal(inbox.polls.at(-1).at, 300000, 'a click polls at once after a long wait')

  inbox.responses.push([{emailId: 11}])
  await inbox.clock.advance(3000)
  assert.deepEqual(inbox.added, [11])
  await inbox.clock.advance(3000)
  assert.equal(inbox.polls.at(-1).at, 306000, 'new mail keeps the configured interval')
})

test('leaving the inbox stops polling and removes the activity listeners', async () => {
  const inbox = mountInbox()
  inbox.hooks.activated()
  assert.ok(inbox.window.listeners.size > 0)
  await inbox.clock.advance(3000)
  inbox.hooks.deactivated()
  await inbox.clock.advance(0)
  assert.equal(inbox.window.listeners.size, 0)
  const count = inbox.polls.length
  await inbox.clock.advance(120000)
  assert.equal(inbox.polls.length, count)
})
