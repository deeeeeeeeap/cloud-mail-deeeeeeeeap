import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc'
import * as Vue from 'vue'
const read = p => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
const select = read('components/refined-select/index.vue')
const about = read('components/settings-about/index.vue')
const pages = ['views/login/index.vue', 'layout/account/index.vue', 'views/user/index.vue', 'views/all-email/index.vue', 'views/sys-setting/index.vue']

test('all modified page and shared component scripts and templates compile together', () => {
  for (const path of [...pages, 'components/refined-select/index.vue', 'components/settings-about/index.vue']) {
    const {descriptor, errors} = parse(read(path), {filename: path})
    assert.deepEqual(errors, [], path)
    const script = compileScript(descriptor, {id: 'design-review'})
    const template = compileTemplate({source: descriptor.template.content, filename: path, id: 'design-review', compilerOptions: {bindingMetadata: script.bindings}})
    assert.deepEqual(template.errors, [], path)
  }
})

test('the actual Element Plus select owns keyboard navigation, focus and disabled state', () => {
  assert.match(select, /import \{ElSelect\} from 'element-plus'/)
  assert.match(select, /v-bind="\$attrs"/)
  assert.match(select, /:aria-label="ariaLabel"/)
  assert.match(select, /:model-value="modelValue"/)
  assert.match(select, /@update:model-value="emit\('update:modelValue', \$event\)"/)
  assert.doesNotMatch(select, /toggleMenu|opacity: 0;|pointer-events: none;.*el-select|@click/)
})

test('Enter selects an option without accidentally submitting the surrounding search', () => {
  assert.match(select, /@keydown\.enter\.stop/)
  assert.match(select, /@keyup\.enter\.stop/)
  assert.doesNotMatch(select, /enter\.prevent/)
  assert.match(read('views/all-email/index.vue'), /@keyup\.enter="search"/)
})

test('menu styling is namespaced, constrained to the viewport and signals selection', () => {
  assert.match(select, /refined-select-popper\.el-popper/)
  assert.match(select, /max-width: calc\(100vw - 24px\)/)
  assert.match(select, /name: 'preventOverflow', options: \{padding: 12\}/)
  assert.match(select, /el-select-dropdown__item\.is-selected::after/)
  assert.match(select, /el-select-dropdown__item\.is-disabled/)
  assert.match(select, /max-height: min\(280px, 50vh\)/)
})

test('domain values, complete labels and independent registration/binding controls are preserved', () => {
  const login = read('views/login/index.vue')
  assert.equal((login.match(/<RefinedSelect v-model="suffix"/g) || []).length, 3)
  assert.equal((login.match(/:title="item"/g) || []).length, 3)
  assert.equal((login.match(/:aria-label="\$t\('domain'\)"/g) || []).length, 3)
  for (const p of ['layout/account/index.vue', 'views/user/index.vue']) {
    assert.match(read(p), /<RefinedSelect v-model="addForm\.suffix"/)
    assert.match(read(p), /:value="item"/)
  }
})

test('about links are real navigation with safe external relationship and retained version badge', () => {
  assert.equal((about.match(/rel="noopener noreferrer"/g) || []).length, 3)
  assert.equal((about.match(/target="_blank"/g) || []).length, 3)
  assert.match(about, /:hidden="!hasUpdate"/)
  assert.match(about, /repoUrl \+ '\/releases'/)
  assert.match(about, /:href="docsUrl"/)
  const page = read('views/sys-setting/index.vue')
  assert.match(page, /:version="currentVersion" :repo-url="projectRepo" :docs-url="projectDoc" :has-update="hasUpdate"/)
  assert.match(page, /const projectRepo = 'https:\/\/github.com\/deeeeeeeeap\/cloud-mail-deeeeeeeeap'/)
})

test('links keep distinct text labels, keyboard focus and a stacked narrow-card layout', () => {
  assert.match(about, /resource-link--github/)
  assert.match(about, /<strong>GitHub<\/strong>/)
  assert.match(about, /\$t\('document'\)/)
  assert.match(about, /resource-link:focus-visible/)
  assert.match(about, /@container \(max-width: 350px\)/)
  assert.match(about, /prefers-reduced-motion: reduce/)
})

test('settings operations keep their handlers and gain spacing without removing confirmation code', () => {
  const s = read('views/sys-setting/index.vue')
  assert.match(s, /column-gap: 10px;\s+row-gap: 8px;/)
  assert.match(s, /@click="openResendList"/)
  assert.match(s, /@click="openResendForm"/)
  assert.match(s, /type="danger" plain @click="delBackground"/)
  assert.match(s, /function delBackground\(/)
  assert.match(s, /ElMessageBox\.confirm/)
})

test('about template renders version and translated labels without inserting raw HTML', () => {
  const {descriptor} = parse(about)
  let {code, errors} = compileTemplate({source: descriptor.template.content, filename: 'About.vue', id: 'test-about'})
  assert.deepEqual(errors, [])
  code = code.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/\s+as\s+/g, ': ')}} = Vue`).replace('export function render', 'function render')
  const render = new Function('Vue', `${code};return render`)(Vue)
  // Avoid resolving external component implementations; inspect our VNode tree.
  const warnings = console.warn
  console.warn = () => {}
  try {
    const vnode = render({$t: x => x, version: 'v1.2.6', repoUrl: 'https://example.test/repo', docsUrl: 'https://example.test/doc', hasUpdate: true}, [])
    assert.equal(vnode.props.class, 'settings-about')
    const links = vnode.children[1].children
    assert.equal(links.length, 2)
    assert.equal(links[0].props.href, 'https://example.test/repo')
    assert.equal(links[1].props.href, 'https://example.test/doc')
    assert.doesNotMatch(about, /v-html|innerHTML/)
  } finally { console.warn = warnings }
})
