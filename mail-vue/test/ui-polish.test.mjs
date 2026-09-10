import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parse, compileTemplate} from 'vue/compiler-sfc'
import * as Vue from 'vue'

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const selectors = ['views/login/index.vue', 'layout/account/index.vue', 'views/user/index.vue', 'views/all-email/index.vue']
const caret = read('components/dropdown-chevron/index.vue')

function caretVNode(expanded) {
  const {descriptor} = parse(caret)
  let {code, errors} = compileTemplate({source: descriptor.template.content, filename: 'DropdownChevron.vue', id: 'caret-test'})
  assert.deepEqual(errors, [])
  code = code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) =>
    `const {${imports.replace(/\s+as\s+/g, ': ')}} = Vue`)
    .replace('export function render', 'function render')
  const render = new Function('Vue', `${code}; return render`)(Vue)
  return render({expanded}, [])
}

test('code cards no longer include a monogram or reserve an avatar column', () => {
  const source = read('views/code-center/index.vue')
  assert.doesNotMatch(source, /source-avatar|slice\(0, 1\)/)
  assert.match(source, /class="source-identity"/)
  assert.match(source, /item\.name \|\| item\.sendEmail/)
  assert.match(source, /item\.toEmail \|\| '-'/)
  assert.match(source, /@click="copyCode\(item\)"/)
  assert.match(source, /@click="openDetail\(item\)"/)
})

test('the collapsed caret is a decorative, centered local SVG', () => {
  const node = caretVNode(false)
  assert.equal(node.type, 'svg')
  assert.equal(node.props.class, 'dropdown-chevron')
  assert.equal(node.props['aria-hidden'], 'true')
  assert.equal(node.props.focusable, 'false')
  assert.equal(node.props.viewBox, '0 0 16 16')
  assert.equal(node.children[0].props.d, 'm4 6 4 4 4-4')
  assert.doesNotMatch(caret, /https?:|@iconify/)
})

test('the expanded caret rotates once and resets when the menu closes', () => {
  assert.equal(caretVNode(true).props.class, 'dropdown-chevron is-expanded')
  assert.equal(caretVNode(false).props.class, 'dropdown-chevron')
  assert.match(caret, /\.dropdown-chevron\.is-expanded \{ transform: rotate\(180deg\); \}/)
  assert.match(caret, /prefers-reduced-motion: reduce/)
})

test('custom input selectors are visible controls rather than hidden click overlays', () => {
  for (const path of selectors) {
    const source = read(path)
    const count = (source.match(/<RefinedSelect /g) || []).length
    assert.equal(count, path.includes('login') ? 3 : 1, path)
    assert.match(source, /select-input-group/)
    assert.doesNotMatch(source, /mySelect|bindSelect|openSelect|select-trigger-label|setting-icon|mingcute:down-small-fill/)
    assert.equal((source.match(/:aria-label=/g) || []).length >= count, true)
  }
})

test('the account menu shares the caret and preserves its mobile visibility rule', () => {
  const source = read('layout/header/index.vue')
  assert.match(source, /<DropdownChevron class="account-chevron" :expanded="userInfoShow"/)
  assert.match(source, /\.toolbar \.account-chevron \{ display: none; \}/)
})

test('manual delivery keeps neutral hover and expansion surfaces with keyboard focus', () => {
  const source = read('views/maintenance/index.vue')
  assert.match(source, /\.manual-summary:hover \{ background: var\(--el-fill-color-light\); \}/)
  assert.match(source, /\.manual-summary:focus-visible \{ outline: 2px solid var\(--el-text-color-secondary\)/)
  assert.doesNotMatch(source, /\.manual[^\n]*--el-color-primary|\.manual-panel\.is-open \{/)
  assert.match(source, /:aria-expanded="manualOpen"/)
  assert.match(source, /:inert="!manualOpen" :aria-hidden="!manualOpen"/)
  assert.match(source, /<DropdownChevron class="manual-chevron" :expanded="manualOpen"/)
  assert.match(source, /await ElMessageBox\.confirm\(repairConfirmText\(action\)/)
  assert.match(source, /if \(action === 'delivery-ack-unknown' \|\| action === 'delivery-fail-unknown'\) \{\s+return t\('unknownDeliveryConfirm'\)/)
})

test('separated input groups reset Element Plus offsets and retain a visible focus state', () => {
  const source = read('style.css')
  assert.match(source, /el-input\.select-input-group[^\n]*gap: 8px/)
  assert.match(source, /margin: 0 !important; height: 100%; border-radius: 8px !important/)
  assert.match(source, /el-select__wrapper\.is-focused/)
  assert.doesNotMatch(source, /select-trigger-label/)
})

test('every affected template compiles with the shared chevron component', () => {
  for (const path of [...selectors, 'layout/header/index.vue', 'views/maintenance/index.vue', 'views/code-center/index.vue', 'components/dropdown-chevron/index.vue']) {
    const {descriptor, errors} = parse(read(path), {filename: path})
    assert.deepEqual(errors, [], path)
    assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: path, id: 'ui-polish'}).errors, [], path)
  }
})
