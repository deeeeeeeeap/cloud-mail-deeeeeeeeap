import assert from 'node:assert/strict'
import test from 'node:test'
import * as Vue from 'vue'
import KeyedVirtualList from '../src/components/email-scroll/keyed-virtual-list.js'

const ITEM_HEIGHT = 48
const settle = () => new Promise(resolve => setImmediate(resolve))

function renderer() {
  return Vue.createRenderer({
    createElement: tag => ({tag, children: [], props: {}, scrollTop: 0, clientHeight: 480}),
    createText: text => ({text}), createComment: text => ({text}),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text },
    patchProp(el, key, prev, next) { el.props[key] = next },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1]
  })
}

async function mountList(t, count = 100) {
  const emails = Vue.shallowRef(Array.from({length: count}, (_, index) => ({emailId: 10000 - index})))
  const mounted = []
  const unmounted = []
  let slotCalls = 0
  const Row = {
    props: ['email'],
    setup(props) {
      Vue.onMounted(() => mounted.push(props.email.emailId))
      Vue.onUnmounted(() => unmounted.push(props.email.emailId))
      return () => Vue.h('div')
    }
  }
  const listRef = Vue.ref(null)
  const app = renderer().createApp({
    render: () => Vue.h(KeyedVirtualList, {
      ref: listRef,
      list: emails.value,
      options: {itemHeight: ITEM_HEIGHT, overscan: 6},
      itemKey: email => email.emailId
    }, {
      default: ({data}) => {
        slotCalls++
        return [Vue.h(Row, {email: data})]
      }
    })
  })
  const root = {children: []}
  app.mount(root)
  t.after(() => app.unmount())
  await settle()
  const container = root.children[0]
  return {
    emails, mounted, unmounted, listRef, container,
    get slotCalls() { return slotCalls },
    async scroll(top) {
      container.scrollTop = top
      container.props.onScroll({currentTarget: container})
      await settle()
    },
    reset() { mounted.length = 0; unmounted.length = 0 }
  }
}

test('shifting the visible range by one row mounts and unmounts only the edge rows', async t => {
  const list = await mountList(t)
  // 480px viewport / 48px rows = 10 rows, plus 6 rows overscan below the first visible row.
  assert.equal(list.mounted.length, 17)
  await list.scroll(10 * ITEM_HEIGHT)
  list.reset()

  await list.scroll(11 * ITEM_HEIGHT)
  assert.deepEqual(list.unmounted, [10000 - 5])
  assert.deepEqual(list.mounted, [10000 - 27])
})

test('scrolling inside the same row does not re-render the list', async t => {
  const list = await mountList(t)
  await list.scroll(3 * ITEM_HEIGHT)
  const calls = list.slotCalls
  for (const offset of [1, 12, 30, 47]) await list.scroll(3 * ITEM_HEIGHT + offset)
  assert.equal(list.slotCalls, calls)
  await list.scroll(4 * ITEM_HEIGHT)
  assert.ok(list.slotCalls > calls, 'crossing a row boundary still recalculates the range')
})

test('a new mail at the top keeps every existing row mounted', async t => {
  const list = await mountList(t)
  list.reset()
  list.emails.value = [{emailId: 10001}, ...list.emails.value]
  await settle()
  assert.deepEqual(list.mounted, [10001])
  assert.deepEqual(list.unmounted, [10000 - 16])
})

test('the exposed scrollTo and root element stay available to the email list', async t => {
  const list = await mountList(t)
  assert.equal(list.listRef.value.$el, list.container)
  list.reset()
  list.listRef.value.scrollTo(40)
  await settle()
  assert.equal(list.container.scrollTop, 40 * ITEM_HEIGHT)
  assert.equal(list.mounted.length, 22, 'the jumped-to range plus overscan on both sides is mounted')
  assert.equal(list.unmounted.length, 17)
})
