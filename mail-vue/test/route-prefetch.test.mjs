import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRoutePrefetcher } from '../src/utils/route-prefetch.js'

function fakeRouter(routes) {
  return {
    hasRoute: name => name in routes,
    resolve: ({ name }) => {
      const matched = routes[name]
      if (matched instanceof Error) throw matched
      return { matched }
    }
  }
}

test('prefetches every lazy component of a route once', async () => {
  const calls = []
  const lazy = label => () => { calls.push(label); return Promise.resolve({}) }
  const prefetch = createRoutePrefetcher(fakeRouter({
    analysis: [{ components: { default: lazy('layout') } }, { components: { default: lazy('analysis') } }]
  }))

  prefetch('analysis')
  prefetch('analysis')
  await Promise.resolve()

  assert.deepEqual(calls, ['layout', 'analysis'])
})

test('skips unknown routes, resolved components and routes that cannot be resolved', () => {
  let constructed = 0
  class ResolvedComponent { constructor() { constructed++ } }
  const prefetch = createRoutePrefetcher(fakeRouter({
    email: [{ components: { default: { name: 'email' } } }, { components: { default: ResolvedComponent } }],
    detail: new Error('Missing required param "id"')
  }))

  assert.doesNotThrow(() => {
    prefetch('missing')
    prefetch('email')
    prefetch('detail')
  })
  assert.equal(constructed, 0)
})

test('a failed download can be retried on the next hover', async () => {
  let attempts = 0
  const prefetch = createRoutePrefetcher(fakeRouter({
    analysis: [{ components: { default: () => { attempts++; return Promise.reject(new Error('offline')) } } }]
  }))

  prefetch('analysis')
  await new Promise(resolve => setImmediate(resolve))
  prefetch('analysis')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(attempts, 2)
})

test('the sidebar prefetches a page when its menu item is hovered or focused', () => {
  const aside = readFileSync(new URL('../src/layout/aside/index.vue', import.meta.url), 'utf8')
  assert.match(aside, /@mouseenter="prefetchRoute\(item\.name\)"/)
  assert.match(aside, /@focus="prefetchRoute\(item\.name\)"/)
  assert.match(aside, /createRoutePrefetcher\(router\)/)
})
