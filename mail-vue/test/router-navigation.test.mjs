import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRouteNavigation } from '../src/router/route-navigation.js'

test('an anonymous login navigation is allowed synchronously', () => {
  const decision = resolveRouteNavigation({
    token: null,
    toName: 'login',
    fromPath: '/',
    setupRequired: false
  })

  assert.deepEqual(decision, { type: 'allow' })
  assert.equal(typeof decision?.then, 'undefined')
})

test('setup and authenticated login redirects keep their existing behavior', () => {
  assert.deepEqual(resolveRouteNavigation({
    token: null,
    toName: 'inbox',
    fromPath: '/',
    setupRequired: true
  }), { type: 'redirect', to: { name: 'setup' } })

  assert.deepEqual(resolveRouteNavigation({
    token: 'token',
    sessionReady: true,
    toName: 'login',
    fromPath: '/inbox',
    setupRequired: false
  }), { type: 'redirect', to: '/inbox' })
})

test('a pending login stays on the login page and cannot enter the inbox', () => {
  assert.deepEqual(resolveRouteNavigation({
    token: 'pending', sessionReady: false, toName: 'login', fromPath: '/', setupRequired: false
  }), { type: 'allow' })
  assert.deepEqual(resolveRouteNavigation({
    token: 'pending', sessionReady: false, toName: 'email', fromPath: '/login', setupRequired: false
  }), { type: 'redirect', to: { name: 'login' } })
})
