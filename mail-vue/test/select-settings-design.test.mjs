import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc'
import * as Vue from 'vue'
import {normalizeSelectOptions, selectedOptionLabel} from '../src/components/ui-select/options.js'
const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const source = read('components/ui-select/index.vue')

test('string options preserve the complete domain and input list', () => {
  const input = ['@zxuu.de', '@very-long-domain.example.test']
  assert.deepEqual(normalizeSelectOptions(input), input.map(value => ({value, label: value, disabled: false})))
  assert.deepEqual(input, ['@zxuu.de', '@very-long-domain.example.test'])
})
test('numeric values, disabled items and translated labels remain distinct', () => {
  assert.deepEqual(normalizeSelectOptions([{value: 0, label: '关闭'}, {value: '0', label: 'Zero', disabled: true}]), [
    {value: 0, label: '关闭', disabled: false}, {value: '0', label: 'Zero', disabled: true}
  ])
  assert.equal(selectedOptionLabel(normalizeSelectOptions([0, '0']), 0), '0')
})
test('missing labels fall back without mutating the source object', () => {
  const option = Object.freeze({value: 'subject'})
  assert.deepEqual(normalizeSelectOptions([option]), [{value: 'subject', label: 'subject', disabled: false}])
  assert.deepEqual(option, {value: 'subject'})
})
test('unknown selection does not invent a value and empty options are valid', () => {
  assert.equal(selectedOptionLabel(normalizeSelectOptions(['a']), 'b'), '')
  assert.deepEqual(normalizeSelectOptions(), [])
})

test('compiled select forwards model, disabled state and update/change without changing values', () => {
  const {descriptor} = parse(source)
  const script = compileScript(descriptor, {id: 'select-test'})
  let {code, errors} = compileTemplate({source: descriptor.template.content, filename: 'UiSelect.vue', id: 'select-test', compilerOptions: {bindingMetadata: script.bindings}})
  assert.deepEqual(errors, [])
  code = code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/\s+as\s+/g, ': ')}} = Vue`).replace('export function render', 'function render')
  const render = new Function('Vue', `${code}; return render`)(Vue)
  const calls = []
  const rendered = render({$attrs: {'aria-label': 'Domain'}, $emit: (...args) => calls.push(args)}, [],
    {modelValue: '@zxuu.de', placeholder: 'Select', disabled: true},
    {ElSelect: 'select-stub', ElOption: 'option-stub', SelectorIcon: 'icon-stub', selectedLabel: '@zxuu.de', normalizedOptions: []})
  const tree = rendered.type === 'select-stub' ? rendered : rendered.children.find(node => node.type === 'select-stub')
  assert.equal(tree.props['model-value'], '@zxuu.de')
  assert.equal(tree.props.disabled, true)
  assert.equal(tree.props['aria-label'], 'Domain')
  assert.equal(tree.props.title, '@zxuu.de')
  tree.props['onUpdate:modelValue']('@new.example')
  tree.props.onChange('@new.example')
  assert.deepEqual(calls, [['update:modelValue', '@new.example'], ['change', '@new.example']])
})
test('Enter selecting an option is isolated from ancestor form/search shortcuts', () => {
  assert.match(source, /@keydown\.enter\.stop @keyup\.enter\.stop/)
  assert.doesNotMatch(source, /@keydown\.enter\.prevent/)
  const search = read('views/all-email/index.vue')
  assert.match(search, /class="mail-search-field"/)
  assert.match(search, /@keyup\.enter="search"/)
  assert.doesNotMatch(search, /#prefix|selectTitle|openSelect/)
})
test('teleported menus are viewport-bounded with readable long option labels', () => {
  assert.match(source, /popper-class="ui-select-menu"/)
  assert.match(source, /:show-arrow="false"/)
  assert.match(source, /max-width: calc\(100vw - 24px\)/)
  assert.match(source, /overflow-wrap: anywhere/)
  assert.match(source, /aria-hidden="true" focusable="false"/)
  assert.match(source, /prefers-reduced-motion: reduce/)
})
test('about links have real safe destinations, separate spacing and keyboard focus', () => {
  const settings = read('views/sys-setting/index.vue')
  assert.equal((settings.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 3)
  assert.match(settings, /:href="projectRepo \+ '\/releases'"/)
  assert.match(settings, /:href="projectRepo"/)
  assert.match(settings, /:href="projectDoc"/)
  assert.match(settings, /\.about-links \{[^\n]*gap: 12px/)
  assert.match(settings, /\.about-links \{ grid-template-columns: 1fr/)
  assert.match(settings, /\.about-link:focus-visible/)
  assert.doesNotMatch(settings, /concerning-item|function jump/)
})
test('settings actions retain their handlers and dangerous buttons retain danger styles', () => {
  const settings = read('views/sys-setting/index.vue')
  for (const action of ['openResendList', 'openResendForm', 'openSetBackground', 'delBackground', 'clearTurnstileKey']) assert.match(settings, new RegExp(`@click="${action}`))
  assert.match(settings, /type="danger" plain @click="delBackground"/)
  assert.match(settings, /\.settings-card \.opt-button\.el-button--primary/)
  const {descriptor, errors} = parse(settings)
  assert.deepEqual(errors, [])
  assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: 'Settings.vue', id: 'settings-test'}).errors, [], 'template compiles')
})
