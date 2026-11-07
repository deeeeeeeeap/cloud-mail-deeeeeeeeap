import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {babelParse, walk} from 'vue/compiler-sfc'
import i18n, {elementLocale, loadLocaleMessages} from '../src/i18n/index.js'
import zh from '../src/i18n/zh.js'
import en from '../src/i18n/en.js'
import tw from '../src/i18n/zh-tw.js'
import ja from '../src/i18n/ja.js'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'])

test('the entry module has no top-level await, so awaiting a chunk that imports the entry cannot deadlock', () => {
  const topLevelAwaits = []
  walk(babelParse(main, {sourceType: 'module'}), {
    enter(node) {
      if (FUNCTION_TYPES.has(node.type)) return this.skip()
      if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) topLevelAwaits.push(node.loc.start.line)
    }
  })
  assert.deepEqual(topLevelAwaits, [])
})

test('the icon set is requested at startup and registered before the app mounts', () => {
  assert.match(main, /const iconsReady = import\('@\/icons\/index\.js'\)/)
  assert.match(main, /init\(\)\s*\.then\(\(\) => iconsReady\)\s*\.then\(\(\) => \{[\s\S]*?app\.mount\('#app'\)/)
  assert.doesNotMatch(readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8'), /icons\/index\.js|element-plus\/es\/locale/)
})

function preloadErrorHarness({flag = null, unsaved = false, onLine = true} = {}) {
  const handler = main.match(/window\.addEventListener\('vite:preloadError', (event => \{[\s\S]*?\n\})\)/)?.[1]
  assert.ok(handler, 'vite:preloadError handler exists')
  const state = {flag, reloads: 0}
  const sessionStorage = {
    getItem: key => key === 'chunk-reloaded' ? state.flag : null,
    setItem: (key, value) => { if (key === 'chunk-reloaded') state.flag = value }
  }
  const location = {reload: () => state.reloads++}
  const useUiStore = () => ({writerRef: {hasUnsavedContent: () => unsaved}})
  const run = new Function('sessionStorage', 'location', 'useUiStore', 'navigator', `return ${handler}`)(sessionStorage, location, useUiStore, {onLine})
  return {state, fire() {
    const event = {defaultPrevented: false, preventDefault() { this.defaultPrevented = true }}
    run(event)
    return event
  }}
}

test('a stale chunk after a deploy reloads the page once and then lets the error surface', () => {
  const harness = preloadErrorHarness()
  assert.equal(harness.fire().defaultPrevented, true)
  assert.deepEqual(harness.state, {flag: '1', reloads: 1})
  assert.equal(harness.fire().defaultPrevented, false)
  assert.equal(harness.state.reloads, 1)
  assert.match(main, /router\.isReady\(\)\.then\(\(\) => sessionStorage\.removeItem\('chunk-reloaded'\), showInitRetry\)/)
})

test('an unsaved draft in the writer is never discarded by the stale chunk reload', () => {
  const harness = preloadErrorHarness({unsaved: true})
  assert.equal(harness.fire().defaultPrevented, false)
  assert.deepEqual(harness.state, {flag: null, reloads: 0})
})

test('an offline chunk failure keeps the running app instead of reloading into an error page', () => {
  const harness = preloadErrorHarness({onLine: false})
  assert.equal(harness.fire().defaultPrevented, false)
  assert.deepEqual(harness.state, {flag: null, reloads: 0})
})

function prefetchHarness(routes) {
  const body = main.match(/function prefetchLandingRoute\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body, 'prefetchLandingRoute exists')
  const loaded = []
  const loader = name => () => { loaded.push(name); return Promise.resolve({}) }
  const router = {
    options: {history: {location: routes.current}},
    resolve: path => routes[path] ? routes[path](loader) : {name: '404', matched: [{components: {default: loader('404')}}]}
  }
  new Function('router', body)(router)
  return loaded
}

test('a returning session prefetches the landing route chunks, following the root redirect', () => {
  const routes = {
    current: '/',
    '/': loader => ({name: 'layout', matched: [{redirect: '/inbox', components: {default: loader('layout')}}]}),
    '/inbox': loader => ({name: 'email', matched: [{components: {default: loader('layout')}}, {components: {default: loader('email')}}]})
  }
  assert.deepEqual(prefetchHarness(routes), ['layout', 'email'])
})

test('admin deep links are not prefetched before their dynamic routes exist', () => {
  assert.deepEqual(prefetchHarness({current: '/all-users'}), [])
})

test('only the current language and its Element Plus locale are loaded', async () => {
  assert.deepEqual(i18n.global.availableLocales, [])
  assert.equal(await loadLocaleMessages('zh-tw'), 'zh-tw')
  assert.deepEqual(i18n.global.availableLocales, ['zh-tw'])
  assert.equal(i18n.global.locale.value, 'zh-tw')
  assert.equal(i18n.global.t('ux.searchAction'), tw.ux.searchAction)
  assert.equal(elementLocale.value.name, 'zh-tw')
})

test('English uses the built-in Element Plus locale and unknown languages fall back to English', async () => {
  assert.equal(await loadLocaleMessages('fr'), 'en')
  assert.equal(i18n.global.locale.value, 'en')
  assert.equal(elementLocale.value, null)
  assert.equal(i18n.global.t('ux.searchAction'), en.ux.searchAction)
  assert.equal(await loadLocaleMessages('ja'), 'ja')
  assert.equal(elementLocale.value.name, 'ja')
  assert.equal(await loadLocaleMessages('zh'), 'zh')
  assert.equal(elementLocale.value.name, 'zh-cn')
})

// Only one language is loaded per page, so a key missing from it has no English fallback.
test('all four languages define exactly the same keys', () => {
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === 'object' ? flatten(child, `${prefix}${key}.`) : [`${prefix}${key}`])
  const expected = flatten(zh).sort()
  for (const [name, messages] of Object.entries({en, 'zh-tw': tw, ja})) {
    assert.deepEqual(flatten(messages).sort(), expected, name)
  }
})
