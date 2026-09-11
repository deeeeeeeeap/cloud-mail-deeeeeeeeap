import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {publishV130} from './publish-v130.mjs'

const sha = '1'.repeat(40)
const base = 'https://api.github.com/repos/deeeeeeeeap/cloud-mail-deeeeeeeeap/'
function fixture({responses = {}, env = {}, version = '1.3.0', backend = version, notes = '# Cloud Mail v1.3.0\n\nReviewed changes'} = {}) {
  const calls = []
  const options = {
    env: {GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'deeeeeeeeap/cloud-mail-deeeeeeeeap', GITHUB_SHA: sha, GH_TOKEN: 'test-only-credential', ...env},
    read: path => path.endsWith('.md') ? notes : JSON.stringify({version: path.startsWith('mail-vue') ? version : backend}),
    fetchImpl: async (url, init) => {
      calls.push({url, ...init})
      const path = url.slice(base.length)
      assert.ok(url.startsWith(base), 'credentials must only reach the intended GitHub repository')
      assert.ok(init.signal instanceof AbortSignal)
      const data = responses[`${init.method} ${path}`] ?? {
        'GET releases/tags/v1.3.0': {status: 404},
        'GET git/ref/heads/main': {object: {sha}},
        'GET git/ref/tags/v1.3.0': {status: 404},
        'POST releases': {tag_name: 'v1.3.0', draft: false, prerelease: false, html_url: 'https://github.com/deeeeeeeeap/cloud-mail-deeeeeeeeap/releases/tag/v1.3.0'}
      }[`${init.method} ${path}`]
      assert.ok(data, `Unexpected API request: ${path}`)
      return new Response(JSON.stringify(data), {status: data.status || 200, headers: {'Content-Type': 'application/json'}})
    }
  }
  return {calls, run: () => publishV130(options)}
}

test('release publishing runs only after verification, in an isolated main-only write job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const job = workflow.slice(workflow.indexOf('  publish-v130:'))
  assert.match(job, /needs: verify/)
  assert.match(job, /github.event_name == 'push'/)
  assert.match(job, /github.ref == 'refs\/heads\/main'/)
  assert.match(job, /contents: write/)
  assert.match(job, /ref: \$\{\{ github.sha \}\}/)
  assert.match(job, /persist-credentials: false/)
  assert.match(job, /node scripts\/publish-v130.mjs/)
  assert.doesNotMatch(job, /pull_request_target|continue-on-error|secrets\.[A-Z_]*(?:PAT|PERSONAL)/)
})

test('only the expected main event and exact commit can publish, before any API access', async () => {
  for (const env of [{GITHUB_EVENT_NAME: 'pull_request'}, {GITHUB_REF: 'refs/heads/other'}, {GITHUB_REPOSITORY: 'other/repo'}, {GITHUB_SHA: 'main'}, {GH_TOKEN: ''}]) {
    const f = fixture({env}); await assert.rejects(f.run()); assert.equal(f.calls.length, 0)
  }
})

test('release version and notes must agree; unrelated future versions are not automatically published', async () => {
  const mismatch = fixture({backend: '1.2.6'}); await assert.rejects(mismatch.run(), /differ/); assert.equal(mismatch.calls.length, 0)
  const future = fixture({version: '1.4.0'}); assert.equal((await future.run()).status, 'skipped'); assert.equal(future.calls.length, 0)
  const wrongNotes = fixture({notes: 'unversioned'}); await assert.rejects(wrongNotes.run(), /notes/)
})

test('creates a stable Latest release targeting the tested SHA, not an unpinned branch', async () => {
  const f = fixture(); const result = await f.run()
  assert.equal(result.status, 'published')
  const writes = f.calls.filter(call => call.method !== 'GET')
  assert.equal(writes.length, 1)
  const body = JSON.parse(writes[0].body)
  assert.equal(body.tag_name, 'v1.3.0'); assert.equal(body.target_commitish, sha)
  assert.equal(body.make_latest, 'true'); assert.equal(body.draft, false); assert.equal(body.prerelease, false)
  assert.match(body.body, /Reviewed changes/)
  assert.doesNotMatch(JSON.stringify(result), /test-only-credential/)
})

test('retries never overwrite a published release or move its existing tag', async () => {
  const f = fixture({responses: {'GET releases/tags/v1.3.0': {draft: false, prerelease: false, html_url: 'existing'}}})
  assert.equal((await f.run()).status, 'skipped'); assert.equal(f.calls.length, 1)
  for (const state of [{draft: true}, {prerelease: true}]) {
    const conflicting = fixture({responses: {'GET releases/tags/v1.3.0': state}})
    await assert.rejects(conflicting.run(), /refusing to replace/)
    assert.equal(conflicting.calls.length, 1)
  }
})

test('a newer main commit prevents publishing an obsolete verified checkout', async () => {
  const f = fixture({responses: {'GET git/ref/heads/main': {object: {sha: '2'.repeat(40)}}}})
  assert.equal((await f.run()).status, 'skipped')
  assert.ok(f.calls.every(call => call.method === 'GET'))
})

test('a tag pointing elsewhere fails closed instead of moving or overwriting it', async () => {
  const f = fixture({responses: {'GET git/ref/tags/v1.3.0': {object: {type: 'commit', sha: '2'.repeat(40)}}}})
  await assert.rejects(f.run(), /refusing to move/)
  assert.ok(f.calls.every(call => call.method === 'GET'))
})

test('matching lightweight and annotated tags are accepted without rewriting Git refs', async () => {
  for (const annotated of [false, true]) {
    const f = fixture({responses: {
      'GET git/ref/tags/v1.3.0': {object: {type: annotated ? 'tag' : 'commit', sha}},
      [`GET git/tags/${sha}`]: {object: {type: 'commit', sha}}
    }})
    assert.equal((await f.run()).status, 'published')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('API authorization failures are not treated as missing releases and never leak the token', async () => {
  const f = fixture({responses: {'GET releases/tags/v1.3.0': {status: 403}}})
  await assert.rejects(f.run(), error => error.message.includes('403') && !error.message.includes('test-only-credential'))
  assert.equal(f.calls.length, 1)
})
