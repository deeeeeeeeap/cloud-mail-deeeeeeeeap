import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { initializeAuthenticatedSession } from '../src/init/auth-bootstrap.js'

function harness() {
  let token = null, generation = 0, starts = 0, requests = 0
  let loadUser = async () => ({ userId: 7, account: { accountId: 8 }, permKeys: [] })
  const navigations = []
  const context = {
    pendingLogin: { value: null }, showBindForm: { value: true },
    oauthLoading: { value: false }, bindLoading: { value: false }, loginLoading: { value: false },
    accountStore: {}, userStore: {}, uiStore: { showNotice() {} },
    startAuthSession(value) { token = value; generation++; starts++ },
    getSessionGeneration: () => generation,
    localStorage: { getItem: () => token },
    clearAuthSession: async () => { token = null; generation++ },
    initializeAuthenticatedSession,
    loginUserInfo: async () => { requests++; return loadUser() },
    permsToRouter: () => [], installDynamicRoutes() {}, refreshWebsiteConfig() {},
    router: { replace: async to => navigations.push(to.name) }
  }
  const component = readFileSync(new URL('../src/views/login/index.vue', import.meta.url), 'utf8')
  const source = component.slice(component.indexOf('async function saveToken(token)'), component.indexOf('function refreshWebsiteConfig()'))
  vm.createContext(context)
  vm.runInContext(source, context)
  return { context, navigations, setLoad: value => { loadUser = value },
    get token() { return token }, get starts() { return starts }, get requests() { return requests }
  }
}

test('a transient user-info failure can be retried without another password login', async () => {
  const h = harness()
  h.setLoad(async () => { throw { response: { status: 503 } } })
  await assert.rejects(h.context.saveToken('session-a'))
  assert.equal(h.token, 'session-a')
  assert.equal(h.context.pendingLogin.value.token, 'session-a')
  assert.equal(h.context.userStore.user, undefined)
  assert.deepEqual(h.navigations, [])
  h.setLoad(async () => ({ userId: 7, account: { accountId: 8 }, permKeys: [] }))
  await h.context.retryLogin()
  assert.equal(h.requests, 2)
  assert.equal(h.starts, 1)
  assert.equal(h.context.pendingLogin.value, null)
  assert.equal(h.context.userStore.user.userId, 7)
  assert.deepEqual(h.navigations, ['layout'])
})

test('a true 401 clears the session without offering a stale retry', async () => {
  const h = harness()
  h.setLoad(async () => { throw { code: 401 } })
  await h.context.saveToken('session-a')
  assert.equal(h.token, null)
  assert.equal(h.context.pendingLogin.value, null)
  assert.deepEqual(h.navigations, [])
})

test('a late failed load cannot clear or offer retry for a newer session', async () => {
  const h = harness()
  let reject
  h.setLoad(() => new Promise((_, fail) => { reject = fail }))
  const pending = h.context.saveToken('old')
  h.context.startAuthSession('new')
  reject({ code: 401 })
  await pending
  assert.equal(h.token, 'new')
  assert.equal(h.context.pendingLogin.value, null)
  assert.deepEqual(h.navigations, [])
})

test('canceling a pending login clears only that session', async () => {
  const h = harness()
  h.setLoad(async () => { throw new Error('Network Error') })
  await assert.rejects(h.context.saveToken('session-a'))
  await h.context.cancelLogin()
  assert.equal(h.token, null)
  assert.equal(h.context.pendingLogin.value, null)
})

test('a pending retry that receives 401 returns to the normal login form', async () => {
  const h = harness()
  h.setLoad(async () => { throw { code: 503 } })
  await assert.rejects(h.context.saveToken('session-a'))
  h.setLoad(async () => { throw { code: 401 } })
  await h.context.retryLogin()
  assert.equal(h.token, null)
  assert.equal(h.context.pendingLogin.value, null)
})
