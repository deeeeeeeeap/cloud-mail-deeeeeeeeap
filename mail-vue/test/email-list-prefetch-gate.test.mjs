import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import * as Vue from 'vue'
import {createRequestCoordinator} from '../src/components/email-scroll/request-coordinator.js'
import {createActiveRuntime} from '../src/components/email-scroll/active-runtime.js'
import {createSelectionState} from '../src/components/email-scroll/selection-state.js'
import {createEmailListScrollbarWatchSource} from '../src/components/email-scroll/email-list-scrollbar-source.js'
import {removeEmailsInPlace} from '../src/components/email-scroll/email-list-mutations.js'

const source = readFileSync(new URL('../src/components/email-scroll/index.vue', import.meta.url), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?\sfrom\s+['"][^'"]+['"];?\r?$/gm, '')
const settle = () => new Promise(resolve => setImmediate(resolve))
const page = (firstId, count = 50) => ({
  list: Array.from({length: count}, (_, index) => ({emailId: firstId - index, createTime: '2026-09-05', text: 'preview'})),
  total: 500, hasMore: true
})

function renderer() {
  return Vue.createRenderer({
    createElement: tag => ({tag, children: []}),
    createText: text => ({text}), createComment: text => ({text}),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text }, patchProp() {},
    insert(node, parent) { node.parent = parent; parent.children.push(node) },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    parentNode: node => node.parent,
    nextSibling: () => null
  })
}

function mountList(t) {
  const requests = []
  const scheduled = []
  let internals
  const props = {
    type: 'email', timeSort: 0,
    getEmailList(emailId) {
      return new Promise(resolve => requests.push({emailId, resolve}))
    }
  }
  const adapters = {
    computed: Vue.computed, onActivated: Vue.onActivated, onDeactivated: Vue.onDeactivated,
    reactive: Vue.reactive, ref: Vue.ref, watch: Vue.watch, nextTick: Vue.nextTick,
    onMounted: Vue.onMounted, onUnmounted: Vue.onUnmounted,
    defineProps: () => props, defineEmits: () => () => {}, defineExpose: value => { internals = {...internals, ...value} },
    useI18n: () => ({t: key => key, locale: Vue.ref('zh')}),
    useSettingStore: () => ({settings: {manyEmail: 0}}),
    useUiStore: () => ({}), useEmailStore: () => Vue.reactive({}),
    useAccountStore: () => ({currentAccountId: 1}),
    fromNow: value => value,
    createRequestCoordinator,
    createActiveRuntime: options => createActiveRuntime({...options, setIntervalFn: () => 1, clearIntervalFn: () => {}}),
    createPagePrefetchController: () => ({
      activate() {}, deactivate() {}, invalidate() {}, consume: () => null,
      schedule: spec => { scheduled.push(spec.key); return true }
    }),
    createSelectionState, createEmailListScrollbarWatchSource, removeEmailsInPlace,
    getSessionGeneration: () => 1,
    registerSessionResetter: () => () => {},
    invalidateEmailDetails() {},
    innerWidth: 1440,
    window: {innerWidth: 1440, addEventListener() {}, removeEventListener() {}},
    DOMRect: {fromRect: value => value},
    requestAnimationFrame: callback => callback()
  }
  const setup = new Function(...Object.keys(adapters), `${source}\nreturn {onScroll}`)
  const app = renderer().createApp({setup() {
    const scope = setup(...Object.values(adapters))
    internals = {...internals, ...scope}
    return () => Vue.h('div')
  }})
  app.mount({children: []})
  t.after(() => app.unmount())
  const scrollTo = async (fraction, scrollHeight = 2400) => {
    internals.onScroll({target: {scrollTop: scrollHeight * fraction, scrollHeight, clientHeight: 900}})
    await settle()
  }
  return {requests, scheduled, scrollTo, get exposed() { return internals }}
}

test('the next page is prefetched only after scrolling past 40% of the loaded list', async t => {
  const list = mountList(t)
  list.requests[0].resolve(page(1000))
  await settle()
  assert.deepEqual(list.scheduled, [], 'opening the inbox without scrolling costs no extra list request')

  await list.scrollTo(0.1, 6000)
  await list.scrollTo(0.39, 6000)
  assert.deepEqual(list.scheduled, [])
  await list.scrollTo(0.41, 6000)
  assert.deepEqual(list.scheduled, ['email:0:951:50'])
  await list.scrollTo(0.6, 6000)
  assert.equal(list.scheduled.length, 1)
  assert.equal(list.requests.length, 1)
})

test('a list invalidated by refresh never prefetches with its old cursor', async t => {
  const list = mountList(t)
  list.requests[0].resolve(page(1000))
  await settle()
  list.exposed.refreshList()
  await list.scrollTo(0.5, 6000)
  assert.deepEqual(list.scheduled, [])

  list.requests[1].resolve(page(2000))
  await settle()
  await list.scrollTo(0.5, 6000)
  assert.deepEqual(list.scheduled, ['email:0:1951:50'])
})

test('reaching 1200px from the bottom still loads the next page directly', async t => {
  const list = mountList(t)
  list.requests[0].resolve(page(1000))
  await settle()
  await list.scrollTo(0.2, 2400)
  assert.equal(list.requests.length, 2)
  assert.equal(list.requests[1].emailId, 951)
})
