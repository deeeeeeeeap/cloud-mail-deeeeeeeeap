import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync, readdirSync} from 'node:fs'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
require('dayjs/locale/zh-cn')
require('dayjs/locale/zh-tw')
require('dayjs/locale/ja')

const source = readFileSync(new URL('../src/utils/day.js', import.meta.url), 'utf8')
const body = source.replace(/^import[^\n]*\r?$/gm, '').replace(/^export /gm, '')
const EXPORTS = 'return {fromNow, formatDetailDate, formatShortDate, formatShortDateTime, tzDayjs}'

// 8f6c275 converted every time with the timezone plugin and the browser's own zone;
// rebuild that version from the current file so the two differ only in the conversion.
function load(lang, {legacy = false} = {}) {
  const code = legacy
    ? `dayjs.extend(timezone)\nconst timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone\n${body.replace(/\.local\(\)/g, '.tz(timeZone)')}`
    : body
  return new Function('dayjs', 'utc', 'timezone', 'useSettingStore', `${code}\n${EXPORTS}`)(
    dayjs, utc, timezone, () => ({lang}))
}

const utcText = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const OFFSETS = [30 * 1000, -10 * 1000, -59 * 1000, -MINUTE, -59 * MINUTE, -HOUR, -119 * MINUTE, -2 * HOUR,
  -5 * HOUR, -23 * HOUR, -DAY, -DAY - HOUR, -2 * DAY, -2 * DAY - 3 * HOUR, -3 * DAY, -40 * DAY, -200 * DAY, -400 * DAY]
const SCENARIOS = [
  ['Asia/Shanghai', '2026-11-07T07:24:00Z'],
  ['Asia/Shanghai', '2026-01-01T16:30:00Z'],
  ['America/New_York', '2026-03-08T07:30:00Z'],
  ['America/New_York', '2026-11-01T06:10:00Z'],
  ['Europe/London', '2026-03-29T01:30:00Z'],
  ['Europe/London', '2026-10-25T23:59:00Z'],
  ['Australia/Lord_Howe', '2026-04-05T15:00:00Z'],
  ['Asia/Kolkata', '2026-12-31T18:40:00Z'],
  ['Pacific/Chatham', '2026-09-27T02:00:00Z']
]
const DST_INSTANTS = ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z',
  '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z']

function render(timers, lang, legacy) {
  const out = []
  for (const [zone, now] of SCENARIOS) {
    process.env.TZ = zone
    timers.setTime(Date.parse(now))
    const day = load(lang, {legacy})
    const instants = [...OFFSETS.map(offset => Date.parse(now) + offset), ...DST_INSTANTS.map(Date.parse)]
    for (const instant of instants) {
      const time = utcText(instant)
      out.push([zone, now, time, day.fromNow(time), day.formatDetailDate(time), day.formatShortDate(time),
        day.formatShortDateTime(time), day.tzDayjs(time).format('YYYY-MM-DD HH:mm Z')])
    }
  }
  return out
}

const wallClock = (instant, zone) => new Intl.DateTimeFormat('en-US', {timeZone: zone, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(instant)
// Local times repeated when clocks fall back (by 30 minutes on Lord Howe Island, an hour elsewhere).
const inRepeatedHour = (instant, zone) => [30 * MINUTE, HOUR].some(shift =>
  wallClock(instant - shift, zone) === wallClock(instant, zone) || wallClock(instant + shift, zone) === wallClock(instant, zone))
function zoneOffset(instant, zone) {
  const name = new Intl.DateTimeFormat('en-US', {timeZone: zone, timeZoneName: 'longOffset'})
    .formatToParts(instant).find(part => part.type === 'timeZoneName').value
  return name === 'GMT' ? '+00:00' : name.slice(3)
}

test('local conversion renders what the timezone plugin rendered, and the true time when clocks fall back', t => {
  const originalZone = process.env.TZ
  t.after(() => { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone })
  t.mock.timers.enable({apis: ['Date'], now: 0})
  const langs = ['zh', 'zh-tw', 'ja', 'en']
  // Install the plugin only after every current-version result exists, so .local() runs without it.
  const current = langs.map(lang => render(t.mock.timers, lang, false))
  const legacy = langs.map(lang => render(t.mock.timers, lang, true))
  let repeatedRows = 0
  langs.forEach((lang, index) => current[index].forEach((row, rowIndex) => {
    const [zone, now, time] = row
    const instant = Date.parse(`${time.replace(' ', 'T')}Z`)
    assert.equal(row[7].slice(-6), zoneOffset(instant, zone), `${zone} ${time}`)
    if (inRepeatedHour(instant, zone)) repeatedRows++
    else assert.deepEqual(row, legacy[index][rowIndex], `${lang} ${zone} now=${now} ${time}`)
  }))
  assert.ok(repeatedRows > 0, 'samples include the repeated hour of a DST change')

  const zh = current[0]
  const tenMinutesOld = rows => rows.find(row => row[1] === '2026-11-01T06:10:00Z' && row[2] === '2026-11-01 06:00:00')
  // On its second pass through 01:xx the plugin placed the mail an hour later, i.e. in the future.
  assert.equal(tenMinutesOld(legacy[0])[3], '几秒前')
  assert.equal(tenMinutesOld(zh)[3], '10分钟前')
  assert.equal(zh[0][3], '几秒前', 'a slightly future timestamp from clock skew still reads as just now')
  assert.ok(zh.some(row => row[3] === '59分钟前'))
  assert.ok(zh.some(row => row[3].startsWith('昨天 ')))
})

test('no source module needs the dayjs timezone plugin any more', () => {
  const files = readdirSync(new URL('../src/', import.meta.url), {recursive: true})
    .filter(path => /\.(js|vue)$/.test(path))
  for (const file of files) {
    const text = readFileSync(new URL(`../src/${file.replaceAll('\\', '/')}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /dayjs\/plugin\/timezone|\.tz\(/, file)
  }
})
