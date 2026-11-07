import assert from 'node:assert/strict'
import test from 'node:test'
import { createPollBackoff, trackUserActivity } from '../src/utils/poll-backoff.js'

function fakeClock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimeout(callback, delay) {
      timers.set(++nextId, { callback, at: time + delay })
      return nextId
    },
    clearTimeout: id => timers.delete(id),
    // Runs due timers one at a time, letting awaiting code continue in between.
    async advance(ms) {
      const target = time + ms
      for (;;) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? []
        if (!timer || timer.at > target) break
        time = timer.at
        timers.delete(id)
        timer.callback()
        await new Promise(resolve => setImmediate(resolve))
      }
      time = target
      await new Promise(resolve => setImmediate(resolve))
    },
    get pending() { return timers.size }
  }
}

function setup({ focused = true } = {}) {
  const clock = fakeClock()
  const state = { focused }
  const backoff = createPollBackoff({ ...clock, hasFocus: () => state.focused })
  // Measures how long one wait takes on the fake clock.
  async function measure(baseMs) {
    const startedAt = clock.now()
    let resolvedAt = null
    backoff.wait(baseMs).then(() => { resolvedAt = clock.now() })
    while (resolvedAt === null) await clock.advance(1000)
    return resolvedAt - startedAt
  }
  return { clock, state, backoff, measure }
}

test('recent activity keeps the configured interval for two minutes of empty polls', async () => {
  const { backoff, measure } = setup()
  for (let elapsed = 0; elapsed < 117000; elapsed += 3000) {
    assert.equal(await measure(3000), 3000)
    backoff.settle(0)
  }
})

test('after the active window empty polls double the interval up to thirty seconds', async () => {
  const { clock, backoff, measure } = setup()
  await clock.advance(120000)
  const delays = []
  for (let round = 0; round < 7; round++) {
    delays.push(await measure(3000))
    backoff.settle(0)
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000, 30000])
})

test('an unfocused window backs off faster but never beyond thirty seconds', async () => {
  const { clock, backoff, measure } = setup({ focused: false })
  await clock.advance(120000)
  const delays = []
  for (let round = 0; round < 5; round++) {
    delays.push(await measure(3000))
    backoff.settle(0)
  }
  assert.deepEqual(delays, [3000, 12000, 24000, 30000, 30000])
  assert.equal(await measure(20000), 30000)
})

test('new mail restores the configured interval at once', async () => {
  const { clock, backoff, measure } = setup()
  await clock.advance(120000)
  for (let round = 0; round < 4; round++) backoff.settle(0)
  assert.equal(await measure(3000), 30000)
  backoff.settle(2)
  assert.deepEqual(backoff.stats(), { idleRounds: 0, waiting: false })
  assert.equal(await measure(3000), 3000)
})

test('activity during a long wait polls now if the base interval has passed', async () => {
  const { clock, backoff } = setup()
  await clock.advance(120000)
  for (let round = 0; round < 4; round++) backoff.settle(0)
  let done = false
  backoff.wait(3000).then(value => { done = value })
  await clock.advance(10000)
  assert.equal(done, false)
  backoff.activity()
  await clock.advance(0)
  assert.equal(done, true)
  assert.equal(clock.pending, 0)
})

test('activity right after a poll still waits out the base interval', async () => {
  const { clock, backoff } = setup()
  await clock.advance(120000)
  for (let round = 0; round < 4; round++) backoff.settle(0)
  let resolvedAt = null
  backoff.wait(5000).then(() => { resolvedAt = clock.now() })
  const startedAt = clock.now()
  await clock.advance(1000)
  backoff.activity()
  await clock.advance(10000)
  assert.equal(resolvedAt - startedAt, 5000)
})

test('aborting a wait resolves false and clears its timer', async () => {
  const { clock, backoff } = setup()
  const controller = new AbortController()
  const pending = backoff.wait(3000, controller.signal)
  assert.equal(clock.pending, 1)
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(clock.pending, 0)
  assert.equal(await backoff.wait(3000, controller.signal), false)
})

test('user activity tracking listens in the capture phase and cleans up', () => {
  const listeners = { window: new Map(), document: new Map() }
  const target = name => ({
    addEventListener(type, listener, options) { listeners[name].set(type, { listener, options }) },
    removeEventListener(type, listener, options) {
      const entry = listeners[name].get(type)
      const capture = typeof options === 'object' ? !!options.capture : !!options
      if (entry?.listener === listener && !!entry.options?.capture === capture) listeners[name].delete(type)
    }
  })
  const document = { ...target('document'), hidden: true }
  let calls = 0
  const stop = trackUserActivity(() => calls++, { window: target('window'), document })
  assert.deepEqual([...listeners.window.keys()], ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'])
  assert.ok([...listeners.window.values()].every(({ options }) => options.capture && options.passive))
  listeners.window.get('keydown').listener({})
  listeners.document.get('visibilitychange').listener()
  assert.equal(calls, 1, 'becoming hidden is not activity')
  document.hidden = false
  listeners.document.get('visibilitychange').listener()
  assert.equal(calls, 2)
  stop()
  assert.equal(listeners.window.size + listeners.document.size, 0)
})
