import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import axios from 'axios'
import { classifyHttpError, isCurrentSessionResponse } from '../src/axios/response-error.js'

function harness() {
  const messages = []
  let rejected, fulfilled, cleared = 0, reloaded = 0
  const source = readFileSync(new URL('../src/axios/index.js', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '')
    .replace('import.meta.env.VITE_BASE_URL', "'/api'")
    .replace('export default http', '')
  vm.runInNewContext(source, {
    axios: { create: () => ({ interceptors: {
      request: { use() {} }, response: { use(ok, fail) { fulfilled = ok; rejected = fail } }
    } }) },
    classifyHttpError, isCurrentSessionResponse,
    i18n: { global: { t: key => key } },
    getSessionGeneration: () => 2,
    clearAuthSession: async () => { cleared++ },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { reload() { reloaded++ } },
    ElMessage: value => messages.push(value.message)
  })
  return { messages, rejected, fulfilled, get cleared() { return cleared }, get reloaded() { return reloaded } }
}

for (const status of [400, 429, 501]) {
  test(`HTTP ${status} preserves the business message and code for callers`, async () => {
    const h = harness()
    const payload = { code: status, message: 'Actionable API message' }
    await assert.rejects(h.rejected({ config: {}, response: { status, data: payload } }), error => error.code === status && error.message === payload.message)
    assert.deepEqual(h.messages, [payload.message])
    assert.equal(h.cleared, 0)
  })
}

test('marked business 502 keeps the do-not-resend warning while unmarked 500 is hidden', async () => {
  const h = harness()
  const payload = { code: 502, message: 'Delivery outcome is unknown; do not retry automatically' }
  await assert.rejects(h.rejected({ config: {}, response: { status: 502, data: payload, headers: { 'x-cloud-mail-error': 'business' } } }), error => error.code === 502)
  assert.deepEqual(h.messages, [payload.message])
  await assert.rejects(h.rejected({ config: {}, response: { status: 500, data: { code: 500, message: 'private details' } } }))
  assert.equal(h.messages.at(-1), 'serverBusyErrorMsg')
})

test('noMsg suppresses UI without changing the business error contract', async () => {
  const h = harness()
  await assert.rejects(h.rejected({ config: { noMsg: true }, response: { status: 400, data: { code: 400, message: 'retry verification' } } }), error => error.code === 400)
  assert.deepEqual(h.messages, [])
})

test('non-JSON edge failures stay generic and canceled requests stay silent', async () => {
  const h = harness()
  await assert.rejects(h.rejected({ config: {}, response: { status: 502, data: '<html>gateway</html>' } }))
  assert.equal(h.messages.at(-1), 'serverBusyErrorMsg')
  h.messages.length = 0
  await assert.rejects(h.rejected(new axios.CanceledError()))
  assert.deepEqual(h.messages, [])
})

test('a late 401 cannot remove the newer session', async () => {
  const h = harness()
  await assert.rejects(h.rejected({ config: { cloudMailSessionGeneration: 1 }, response: { status: 401, data: { code: 401, message: 'old session' } } }))
  assert.equal(h.cleared, 0)
  assert.deepEqual(h.messages, [])
})
