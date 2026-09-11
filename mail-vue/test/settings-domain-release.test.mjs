import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc'
import {isNewerStableRelease} from '../src/utils/release-version.js'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const source = read('../src/views/sys-setting/index.vue')
const {descriptor} = parse(source)
function method(name, scope) {
  const match = source.match(new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `${name} exists`)
  return new Function(...Object.keys(scope), match[1]).bind(null, ...Object.values(scope))
}

test('domain layout removes conflicting legacy grids and uses explicit spacing', () => {
  assert.doesNotMatch(source, /r2domain-item|class="r2domain"|\.r2domain\s*\{/)
  assert.match(source, /class="storage-domain-header"/)
  assert.match(source, /class="storage-domain-value"/)
  assert.match(source, /\.storage-domain-header\s*\{[^}]*gap: 12px/s)
  assert.match(source, /\.storage-domain-text\s*\{[^}]*overflow-wrap: anywhere/s)
  assert.match(source, /\.storage-domain-setting \+ \.setting-item/)
})

test('domain display preserves its complete value and has a translated empty state', () => {
  assert.match(source, /:title="setting\.r2Domain \|\| \$t\('notConfigured'\)"/)
  assert.match(source, /\{\{ setting\.r2Domain \|\| \$t\('notConfigured'\) \}\}/)
  assert.match(source, /class="storage-domain-help" type="button" :aria-label=/)
  assert.match(source, /:trigger="\['hover', 'focus'\]"/)
  for (const locale of ['zh', 'en', 'zh-tw', 'ja']) {
    assert.match(read(`../src/i18n/${locale}.js`), /notConfigured:/)
  }
})

test('opening the domain editor uses the latest saved value, not a canceled draft', () => {
  const scope = {settingLoading: {value: false}, settingReady: {value: true}, setting: {value: {r2Domain: 'saved.example.test'}}, r2DomainInput: {value: 'canceled.test'}, r2DomainShow: {value: false}}
  const open = method('openR2Domain', scope)
  open()
  assert.equal(scope.r2DomainInput.value, 'saved.example.test')
  assert.equal(scope.r2DomainShow.value, true)
  for (const blocked of ['settingLoading', 'settingReady']) {
    scope.r2DomainShow.value = false
    scope.settingLoading.value = blocked === 'settingLoading'
    scope.settingReady.value = blocked !== 'settingReady'
    open()
    assert.equal(scope.r2DomainShow.value, false)
  }
})

test('saving a domain trims paste whitespace and keeps the existing API payload, including clear', () => {
  const calls = []
  const scope = {r2DomainInput: {value: '  files.example.test  '}, editSetting: value => calls.push(value)}
  const save = method('saveR2domain', scope)
  save()
  scope.r2DomainInput.value = '   '
  save()
  assert.deepEqual(calls, [{r2Domain: 'files.example.test'}, {r2Domain: ''}])
})

test('domain Enter and button use one prevented submit, while all other forms prevent navigation', () => {
  assert.match(source, /<form @submit\.prevent="saveR2domain">/)
  assert.match(source, /<el-button native-type="submit" type="primary" :loading="settingLoading"/)
  assert.doesNotMatch(source, /@click="saveR2domain"/)
  for (const form of source.matchAll(/<(?:el-)?form(?=[\s>])[^>]*>/g)) {
    assert.match(form[0], /@submit\.prevent/)
  }
})

test('verification options use distinct keys without changing numeric security policy values', () => {
  for (const field of ['registerVerify', 'addEmailVerify']) {
    const select = source.match(new RegExp(`v-model="setting\\.${field}"([\\s\\S]*?)</el-select>`))[1]
    assert.deepEqual([...select.matchAll(/key="([^\"]+)" :value="(\d)"/g)].map(m => [m[1], Number(m[2])]), [['enable', 0], ['disable', 1], ['rules', 2]])
  }
})

test('stable release comparison distinguishes newer versions from current/older versions', () => {
  for (const latest of ['v1.3.1', 'v1.4.0', 'v2.0.0']) assert.equal(isNewerStableRelease(latest, 'v1.3.0'), true)
  for (const latest of ['v1.2.6', 'v1.3.0', '1.3.0', '1.3.0+build.5']) assert.equal(isNewerStableRelease(latest, 'v1.3.0'), false)
  assert.equal(isNewerStableRelease('v1.10.0', 'v1.9.0'), true)
  assert.equal(isNewerStableRelease('v1.9.9', 'v1.10.0'), false)
  assert.equal(isNewerStableRelease('v1.3.1+build.5', '1.3.0'), true)
  assert.equal(isNewerStableRelease('v9007199254740993.0.0', 'v9007199254740992.0.0'), true)
})

test('invalid, legacy and prerelease metadata do not advertise a stable update', () => {
  for (const version of [undefined, null, {}, 130, '', 'v1.20', 'Cloud Mail v2.0.0', 'v2.0.0-rc.1', '2.00.0', '2.0.0junk', '2.0.0+']) {
    assert.equal(isNewerStableRelease(version, '1.3.0'), false, String(version))
    assert.equal(isNewerStableRelease('2.0.0', version), false, String(version))
  }
})

test('both packages share 1.3.0 and the displayed version is sourced from the frontend package', () => {
  assert.equal(JSON.parse(read('../package.json')).version, '1.3.0')
  assert.equal(JSON.parse(read('../../mail-worker/package.json')).version, '1.3.0')
  assert.match(source, /import packageInfo from "\.\.\/\.\.\/\.\.\/package\.json"/)
  assert.match(source, /const currentVersion = `v\$\{packageInfo\.version\}`/)
  assert.match(source, /hasUpdate\.value = isNewerStableRelease\(latest, currentVersion\)/)
})

test('the complete settings template and setup script compile together', () => {
  const script = compileScript(descriptor, {id: 'settings-domain-release'})
  const compiled = compileTemplate({source: descriptor.template.content, filename: 'Settings.vue', id: 'settings-domain-release', compilerOptions: {bindingMetadata: script.bindings}})
  assert.deepEqual(compiled.errors, [])
})

// Static sibling keys are easy to duplicate when another option is added.
// Check the complete source tree so the all-email status filter stays covered too.
test('all Vue templates have unique static keys among siblings', () => {
  const files = readdirSync(new URL('../src/', import.meta.url), {recursive: true})
    .filter(path => path.endsWith('.vue'))
  for (const file of files) {
    const {descriptor} = parse(read(`../src/${file.replaceAll('\\', '/')}`))
    function visit(node) {
      const keys = new Set()
      for (const child of node?.children || []) {
        const key = child.props?.find(prop => prop.type === 6 && prop.name === 'key')?.value?.content
        if (key !== undefined) {
          assert.ok(!keys.has(key), `${file}:${child.loc.start.line} duplicates key ${key}`)
          keys.add(key)
        }
        visit(child)
      }
    }
    visit(descriptor.template?.ast)
  }
})
