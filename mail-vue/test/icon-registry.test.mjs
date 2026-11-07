import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const sources = readdirSync(new URL('../src/', import.meta.url), {recursive: true})
  .map(path => path.replaceAll('\\', '/'))
  .filter(path => /\.(vue|js)$/.test(path) && !path.startsWith('i18n/'))
  .map(path => ({path, text: read(path)}))

const registered = new Set()
new Function('addCollection', read('icons/index.js').replace(/^import .*$/m, ''))(data => {
  for (const name of Object.keys(data.icons)) registered.add(`${data.prefix}:${name}`)
})

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/
const literals = text => [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map(m => m[1] ?? m[2])

// Icons are referenced as icon="…", inside :icon="…" bindings, or as `icon: '…'` in menu/status tables.
function usedIcons() {
  const used = new Map()
  for (const {path, text} of sources.filter(source => !source.path.startsWith('icons/'))) {
    const names = [
      ...[...text.matchAll(/(?<![:\w-])icon="([^"]+)"/g)].map(m => m[1]),
      ...[...text.matchAll(/:icon="([^"]+)"/g)].flatMap(m => literals(m[1]).filter(lit => ICON_NAME.test(lit))),
      ...[...text.matchAll(/\bicon:\s*(['"])([^'"]+)\1/g)].map(m => m[2])
    ]
    for (const name of names) used.set(name, [...(used.get(name) || []), path])
  }
  return used
}

test('every icon used in the source is bundled, because the offline Icon renders nothing for unknown names', () => {
  const missing = [...usedIcons()].filter(([name]) => !registered.has(name)).map(([name, paths]) => `${name} (${paths.join(', ')})`)
  assert.deepEqual(missing, [])
})

test('the bundled icon set carries no unused icons', () => {
  const used = usedIcons()
  assert.deepEqual([...registered].filter(name => !used.has(name)), [])
})

test('Icon and addCollection share the offline entry, so no icon is fetched from api.iconify.design', () => {
  const imports = sources.flatMap(({path, text}) =>
    [...text.matchAll(/from\s+['"](@iconify\/vue[^'"]*)['"]/g)].map(m => `${path}: ${m[1]}`))
  assert.ok(imports.length > 0)
  assert.deepEqual(imports.filter(entry => !entry.endsWith(': @iconify/vue/offline')), [])
  assert.match(read('icons/index.js'), /^import \{addCollection\} from "@iconify\/vue\/offline";/)
})
