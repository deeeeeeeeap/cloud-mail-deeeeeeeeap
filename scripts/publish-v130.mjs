#!/usr/bin/env node
// Deliberately limited to the requested v1.3.0 release. Invoked only by the
// read-only verification job's successful, separately permissioned successor.
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

const REPOSITORY = 'deeeeeeeeap/cloud-mail-deeeeeeeeap'
const VERSION = '1.3.0'
const TAG = `v${VERSION}`
const root = fileURLToPath(new URL('../', import.meta.url))

export async function publishV130({env = process.env, fetchImpl = globalThis.fetch, read = path => readFileSync(resolve(root, path), 'utf8')} = {}) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new Error('Release requires a verified main push in the intended repository')
  }
  const sha = env.GITHUB_SHA || ''
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Release requires a full verified commit SHA')
  const frontend = JSON.parse(read('mail-vue/package.json')).version
  const backend = JSON.parse(read('mail-worker/package.json')).version
  if (frontend !== backend) throw new Error('Frontend and backend release versions differ')
  if (frontend !== VERSION) return {status: 'skipped', reason: 'Not the v1.3.0 source version'}
  const notes = read('doc/release-1.3.0.md').trim()
  if (!notes.startsWith('# Cloud Mail v1.3.0')) throw new Error('Versioned release notes are missing or mismatched')
  if (!env.GH_TOKEN) throw new Error('Missing release job credential')

  async function api(path, {method = 'GET', body, allowMissing = false} = {}) {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method,
      headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
      signal: AbortSignal.timeout(20000)
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`)
    return response.json()
  }

  const existing = await api(`releases/tags/${TAG}`, {allowMissing: true})
  if (existing) {
    if (existing.draft || existing.prerelease) throw new Error('Existing v1.3.0 is not a stable public release; refusing to replace it')
    // Future main pushes and workflow retries must not move the tag, replace
    // release notes, send another notification, or reset a newer Latest release.
    return {status: 'skipped', reason: 'v1.3.0 is already published', url: existing.html_url}
  }
  const main = await api('git/ref/heads/main')
  if (main.object?.sha !== sha) return {status: 'skipped', reason: 'main advanced beyond this verified commit'}
  const tag = await api(`git/ref/tags/${TAG}`, {allowMissing: true})
  if (tag) {
    const target = tag.object?.type === 'tag' ? (await api(`git/tags/${tag.object.sha}`)).object : tag.object
    if (target?.type !== 'commit' || target.sha !== sha) throw new Error('Existing v1.3.0 tag points elsewhere; refusing to move it')
  }
  const release = await api('releases', {method: 'POST', body: {
    tag_name: TAG, target_commitish: sha, name: 'Cloud Mail v1.3.0',
    body: `${notes}\n\n发布提交：\`${sha}\`。此提交已通过完整 CI 测试和正式构建。`,
    draft: false, prerelease: false, make_latest: 'true'
  }})
  if (release.tag_name !== TAG || release.draft || release.prerelease) throw new Error('Unexpected release state returned by GitHub')
  return {status: 'published', tag: TAG, sha, url: release.html_url}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishV130().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
