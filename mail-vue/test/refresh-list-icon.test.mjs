import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const icon = read('../src/components/refresh-list-icon/index.vue')
const page = read('../src/views/code-center/index.vue')

test('the refreshed artwork is a locally bundled circular arrow, not a remote icon request', () => {
  const {descriptor} = parse(icon)
  const script = compileScript(descriptor, {id: 'refresh-list'})
  const result = compileTemplate({source: descriptor.template.content, filename: 'refresh-list-icon.vue', id: 'refresh-list', compilerOptions: {bindingMetadata: script.bindings}})
  assert.deepEqual(result.errors, [])
  assert.match(icon, /viewBox="0 0 24 24"/)
  assert.match(icon, /stroke-width="1\.75"/)
  assert.match(icon, /stroke="currentColor"/)
  assert.match(icon, /aria-hidden="true" focusable="false"/)
  assert.doesNotMatch(icon, /https?:|<image|@iconify|<use/)
})

test('manual refresh uses existing request state for motion, busy feedback and duplicate-click protection', () => {
  const button = page.match(/<button class="refresh-button"[\s\S]*?<\/button>/)?.[0]
  assert.ok(button)
  assert.match(button, /type="button"/)
  assert.match(button, /:aria-label="\$t\('refreshList'\)"/)
  assert.match(button, /:disabled="loading \|\| loadingMore"/)
  assert.match(button, /:aria-busy="loading \|\| loadingMore"/)
  assert.match(button, /<RefreshListIcon :spinning="loading \|\| loadingMore"/)
  assert.match(button, /@click="refresh"/)
  assert.doesNotMatch(button, /cloud-mail:refresh|checking|setInterval/)
})

test('refresh control has explicit centered geometry and keyboard focus independent of hover', () => {
  assert.match(page, /\.refresh-button\s*\{\s*display: inline-flex; align-items: center; justify-content: center;/)
  assert.match(page, /width: 40px; height: 40px;/)
  assert.match(page, /width: 44px; height: 44px; grid-column: 3/)
  assert.match(page, /\.refresh-button:focus-visible\s*\{[^}]*outline:/)
  assert.match(page, /\.refresh-button:hover:not\(:disabled\)/)
})

test('only pending requests rotate the icon and reduced-motion users get a static busy control', () => {
  assert.match(icon, /spinning: \{type: Boolean, default: false\}/)
  assert.match(icon, /\.refresh-list-icon\.is-refreshing \{ animation: refresh-list-turn/)
  assert.match(icon, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.refresh-list-icon\.is-refreshing \{ animation: none;/)
  assert.doesNotMatch(icon, /:hover.*animation/)
})
