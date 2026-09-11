<template>
  <section class="code-center" :aria-label="$t('codeCenter')">
    <form class="code-toolbar" role="search" @submit.prevent="search">
      <el-input v-model="params.query" class="search-input" :aria-label="$t('ux.codeSearch')"
        :placeholder="$t('ux.codeSearch')" clearable @clear="search">
        <template #prefix><Icon icon="cloud-mail:search" width="18" height="18" aria-hidden="true" /></template>
        <template #append><button class="input-search" type="submit" :aria-label="$t('ux.searchAction')">{{ $t('ux.searchAction') }}</button></template>
      </el-input>
      <el-select v-model="params.stale" class="status-select" :aria-label="$t('ux.codeWindow')" @change="refresh">
        <el-option :label="$t('ux.recentWindow')" value="fresh" />
        <el-option :label="$t('all')" value="all" />
        <el-option :label="$t('ux.olderWindow')" value="stale" />
      </el-select>
      <button v-if="scope === 'mine' && params.stale !== 'stale'" class="wait-button" type="button" :aria-pressed="waiting"
        :title="$t('ux.codePaused')" @click="waiting = !waiting">
        <span class="wait-dot" :class="{checking}" aria-hidden="true"></span>{{ waiting ? $t('ux.codeStopWait') : $t('ux.codeWait') }}
      </button>
      <button class="refresh-button" type="button" :aria-label="$t('refreshList')" :title="$t('refreshList')"
        :disabled="loading || loadingMore" :aria-busy="loading || loadingMore" @click="refresh">
        <RefreshListIcon :spinning="loading || loadingMore" />
      </button>
    </form>

    <div class="code-subnav">
      <div v-if="canViewAll" class="scope-tabs" role="group" :aria-label="$t('ux.codeScope')">
        <button type="button" :aria-pressed="scope === 'mine'" @click="scope = 'mine'; refresh()">{{ $t('myCodes') }}</button>
        <button type="button" :aria-pressed="scope === 'all'" @click="scope = 'all'; refresh()">{{ $t('allCodes') }}</button>
      </div>

      <span v-if="lastCheckedAt" class="last-check">{{ $t('ux.codeLastCheck', {time: displayTime(lastCheckedAt)}) }}</span>
      <button type="button" class="help-toggle" :aria-label="$t('ux.codeHelpTitle')" :title="$t('ux.codeHelpTitle')"
        :aria-expanded="helpOpen" aria-controls="code-display-help" @click="helpOpen = !helpOpen">
        <span class="help-label">{{ $t('ux.codeHelpTitle') }}</span><span class="help-mark" aria-hidden="true">?</span>
      </button>
    </div>

    <div v-if="waiting" class="waiting-status" role="status" :class="{'sync-error': backgroundFailed}">
      {{ backgroundFailed ? $t('ux.codeCheckFailed') : $t('ux.codeWaiting') }}
    </div>
    <p v-if="helpOpen" id="code-display-help" class="code-help">{{ $t('ux.codeHelp') }}</p>
    <span class="sr-only" role="status" aria-live="polite">{{ copiedAnnouncement }}</span>

    <el-scrollbar class="code-scroll" :aria-busy="loading || loadingMore">
      <div v-if="newCodeCount" class="new-codes" role="status">
        <el-button type="primary" plain :disabled="loading" @click="refresh">{{ $t('ux.codeNew', {count: newCodeCount}) }}</el-button>
      </div>
      <div v-if="first" class="code-grid" aria-hidden="true">
        <div v-for="index in 3" :key="index" class="code-card"><el-skeleton :rows="3" animated /></div>
      </div>
      <div v-else class="code-grid">
        <article class="code-card" v-for="item in codes" :key="`${scope}-${item.emailId}`"
          :class="{stale: item.isStale, copied: copiedEmailId === item.emailId}">
          <div class="card-source">
            <div class="source-identity">
              <h2 :title="item.sendEmail">{{ item.name || item.sendEmail || '-' }}</h2>
              <p class="recipient" :title="item.toEmail"><span class="sr-only">{{ $t('ux.codeTo') }}: </span>{{ item.toEmail || '-' }}</p>
            </div>
          </div>
          <div class="code-value-row">
            <span class="code-value" :class="{hidden: item.isStale || !item.code}">{{ displayCode(item) }}</span>
            <button class="copy-button" type="button" :disabled="item.isStale || !item.code"
              :aria-label="$t('copyCode') + ': ' + (item.name || item.sendEmail || '')" @click="copyCode(item)">
              <Icon :icon="copiedEmailId === item.emailId ? 'cloud-mail:check' : 'cloud-mail:copy'" width="18" height="18" aria-hidden="true" />
              {{ copiedEmailId === item.emailId ? $t('copied') : $t('copy') }}
            </button>
          </div>
          <p class="code-subject" :title="item.subject">{{ item.subject || $t('noSubject') }}</p>
          <p v-if="scope === 'all'" class="code-owner" :title="item.userEmail">{{ $t('user') }}: {{ item.userEmail }}</p>
          <footer class="card-footer">
            <span class="code-age" :title="displayTime(item.createTime)">{{ codeStatusText(item) }}</span>
            <button class="detail-button" type="button" @click="openDetail(item)">{{ $t('ux.codeOriginal') }} <span aria-hidden="true">↗</span></button>
          </footer>
        </article>
      </div>
      <div v-if="loadFailed" class="code-load-error" role="alert">
        <span>{{ $t('listLoadFailed') }}</span><el-button :loading="loading || loadingMore" @click="getList(retryRefresh)">{{ $t('retry') }}</el-button>
      </div>
      <div v-if="!first && !loadFailed && codes.length === 0" class="code-empty">
        <div class="empty-mark" aria-hidden="true"><Icon icon="cloud-mail:code" width="32" height="32" /></div>
        <h2>{{ appliedQuery ? $t('ux.codeNoMatch') : params.stale === 'stale' ? $t('noVerificationCodeFound') : $t('ux.codeEmptyTitle') }}</h2>
        <p>{{ $t('ux.codeEmptyHelp') }}</p>
        <el-button v-if="appliedQuery" @click="clearSearch">{{ $t('ux.codeClearSearch') }}</el-button>
      </div>
      <div v-if="codes.length > 0 && hasMore" class="code-load-more">
        <el-button :loading="loadingMore" @click="loadMore">{{ $t('loadMore') }}</el-button>
      </div>
    </el-scrollbar>
  </section>
</template>
<script setup>
import {computed, defineOptions, onBeforeUnmount, reactive, ref, watch} from "vue";
import {Icon} from "@iconify/vue";
import RefreshListIcon from "@/components/refresh-list-icon/index.vue";
import {ElMessage} from "element-plus";
import router from "@/router/index.js";
import {createVisiblePoller} from '@/utils/visible-poller.js';
import {codeAllList, codeList} from "@/request/code.js";
import {hasPerm} from "@/perm/perm.js";
import {useEmailStore} from "@/store/email.js";
import {useI18n} from "vue-i18n";
import {formatShortDateTime} from "@/utils/day.js";

defineOptions({
  name: 'code-center'
})

const {t} = useI18n()
const emailStore = useEmailStore()
const canViewAll = computed(() => hasPerm('all-email:query'))
const scope = ref('mine')
const codes = reactive([])
const loading = ref(false)
const loadingMore = ref(false)
const first = ref(true)
const hasMore = ref(false)
const loadFailed = ref(false)
const copiedEmailId = ref(0)
let copyTimer = 0
let expiryTimer = 0
let requestSeq = 0
let listKey = ''
let listParams = {}
let retryRefresh = true
let foregroundController
const waiting = ref(false)
const checking = ref(false)
const backgroundFailed = ref(false)
const lastCheckedAt = ref(0)
const newCodeCount = ref(0)
const helpOpen = ref(false)
const appliedQuery = ref('')
const copiedAnnouncement = ref('')
const params = reactive({
  query: '',
  stale: 'fresh',
  size: 30,
  emailId: 0,
  timeSort: 0
})

watch(canViewAll, value => {
  if (!value && scope.value === 'all') {
    scope.value = 'mine'
    refresh()
  }
})

function requestList(requestScope, requestParams, options = {}) {
  return requestScope === 'all' ? codeAllList(requestParams, options) : codeList(requestParams, options)
}

function search() {
  refresh()
}

function refresh() {
  newCodeCount.value = 0
  if (scope.value !== 'mine' || params.stale === 'stale') waiting.value = false
  return getList(true)
}

function clearSearch() {
  params.query = ''
  return refresh()
}

function loadMore() {
  if (!hasMore.value || loading.value || loadingMore.value || codes.length === 0) return
  return getList(false)
}

async function getList(refreshList = false) {
  if (!refreshList && (loading.value || loadingMore.value)) return
  const requestScope = scope.value
  const requestParams = {
    ...(refreshList ? params : listParams),
    emailId: refreshList ? 0 : codes.at(-1)?.emailId || 0
  }
  const key = JSON.stringify([requestScope, requestParams.query, requestParams.stale, requestParams.timeSort, requestParams.size])
  if (key === listKey && (loading.value || loadingMore.value)) return
  if (key !== listKey) {
    codes.length = 0
    hasMore.value = false
    first.value = true
    copiedEmailId.value = 0
    updateExpiry()
  }
  listKey = key
  listParams = requestParams
  const requestId = ++requestSeq
  foregroundController?.abort()
  const controller = new AbortController()
  foregroundController = controller
  if (refreshList) appliedQuery.value = requestParams.query
  const requestedAt = Date.now()
  loading.value = refreshList
  loadingMore.value = !refreshList
  loadFailed.value = false
  retryRefresh = refreshList
  try {
    const data = await requestList(requestScope, requestParams, {signal: controller.signal, noMsg: true})
    if (requestId !== requestSeq || requestScope !== scope.value) return
    if (refreshList) codes.length = 0
    codes.push(...(data.list || []).map(item => {
      // Keep the server display/privacy window. Do not present it as OTP validity.
      const seconds = Number(item.expiresInSeconds ?? (item.expiresInMinutes ?? 0) * 60)
      return {...item, observedAt: requestedAt, expiresAt: requestedAt + (Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0)}
    }))
    updateExpiry()
    lastCheckedAt.value = Date.now()
    backgroundFailed.value = false
    newCodeCount.value = 0
    hasMore.value = !!data.hasMore
  } catch {
    if (requestId === requestSeq) loadFailed.value = true
  } finally {
    if (requestId !== requestSeq) return
    first.value = false
    loading.value = false
    loadingMore.value = false
  }
}

function updateExpiry() {
  clearTimeout(expiryTimer)
  const now = Date.now()
  let nextUpdate = Infinity
  for (const item of codes) {
    const remaining = item.isStale ? 0 : Math.max(0, item.expiresAt - now)
    item.expiresInMinutes = Math.ceil(remaining / 60000)
    if (remaining <= 0) {
      item.isStale = true
      item.codeHidden = true
      item.code = ''
      if (copiedEmailId.value === item.emailId) copiedEmailId.value = 0
    } else {
      nextUpdate = Math.min(nextUpdate, remaining - (item.expiresInMinutes - 1) * 60000)
    }
  }
  if (!document.hidden && Number.isFinite(nextUpdate)) {
    expiryTimer = window.setTimeout(updateExpiry, Math.max(1, nextUpdate))
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) {
    throw new Error('copy failed')
  }
}

async function copyCode(item) {
  updateExpiry()
  const code = item?.code
  if (!code || item?.isStale) return

  try {
    await writeClipboard(code)
    copiedEmailId.value = item.emailId
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedEmailId.value = 0
    }, 1500)
    copiedAnnouncement.value = t('ux.codeCopyDone')
  } catch {
    ElMessage({message: t('copyFailMsg'), type: 'error'})
  }
}

function openDetail(item) {
  emailStore.contentData.email = {
    ...item,
    recipient: JSON.stringify([{address: item.toEmail || ''}]),
    attList: [],
    content: '',
    text: ''
  }
  emailStore.contentData.delType = scope.value === 'all' ? 'physics' : 'logic'
  emailStore.contentData.showUnread = false
  emailStore.contentData.showStar = scope.value !== 'all'
  emailStore.contentData.showReply = scope.value !== 'all'
  router.push({name: 'content'})
}

function displayTime(time) {
  return time ? formatShortDateTime(time) : '-'
}

function codeStatusText(item) {
  if (item.isStale) return t('ux.codeHiddenPolicy')
  const initialAge = Number(item.ageMinutes)
  if (item.ageMinutes == null || !Number.isFinite(initialAge)) return t('ux.codeRecent')
  const age = Math.max(0, initialAge + Math.floor((Date.now() - item.observedAt) / 60000))
  return age > 0 ? t('ux.codeReceivedMinutes', {minutes: age}) : t('ux.codeRecent')
}

function displayCode(item) {
  if (item.isStale || !item.code) return t('ux.codeHiddenValue')
  return item.code
}

async function pollForCodes(signal) {
  if (loading.value || loadingMore.value || first.value || loadFailed.value) return false
  const generation = requestSeq
  checking.value = true
  try {
    // Use the last SUBMITTED query, never partially typed search text.
    const data = await requestList('mine', {...listParams, emailId: 0}, {signal, noMsg: true})
    if (signal.aborted || generation !== requestSeq || scope.value !== 'mine') return true
    const knownIds = new Set(codes.map(item => item.emailId))
    newCodeCount.value = (data.list || []).filter(item => !knownIds.has(item.emailId)).length
    lastCheckedAt.value = Date.now()
    backgroundFailed.value = false
    return true
  } catch (error) {
    if (!signal.aborted && generation === requestSeq) backgroundFailed.value = true
    return false
  } finally {
    if (!signal.aborted) checking.value = false
  }
}

const poller = createVisiblePoller({run: pollForCodes})
watch(waiting, enabled => {
  checking.value = false
  backgroundFailed.value = false
  if (enabled && scope.value === 'mine' && params.stale !== 'stale') poller.start()
  else poller.stop()
})

onBeforeUnmount(() => {
  requestSeq++
  foregroundController?.abort()
  poller.dispose()
  if (copyTimer) clearTimeout(copyTimer)
  clearTimeout(expiryTimer)
  document.removeEventListener('visibilitychange', updateExpiry)
})

document.addEventListener('visibilitychange', updateExpiry)
getList(true)
</script>
<style scoped lang="scss">
.code-center { height: 100%; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.code-toolbar { display: flex; gap: 8px; align-items: center; padding: 16px 24px 12px; }
.search-input { flex: 1; min-width: 0; max-width: 600px; }
.status-select { width: 172px; flex: 0 0 172px; }
.code-toolbar :deep(.el-input__wrapper), .code-toolbar :deep(.el-select__wrapper) { min-height: 40px; }
.input-search { min-width: 44px; min-height: 40px; padding: 4px 10px; color: var(--el-text-color-regular); cursor: pointer; }
.search-input :deep(.el-input-group__append) { padding: 0; background: var(--extra-light-fill); }
.last-check { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
.waiting-status { padding: 6px 24px; font-size: 12px; color: var(--el-text-color-secondary); }
.help-mark { display: none; }
.refresh-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; flex-shrink: 0; margin: 0; padding: 0;
  border: 1px solid var(--el-border-color-light); border-radius: 9px;
  background: var(--el-bg-color); color: var(--el-text-color-regular); cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease;
}
.refresh-button:hover:not(:disabled) {
  background: var(--el-fill-color-light); border-color: var(--el-border-color);
}
.refresh-button:focus-visible { outline: 2px solid var(--el-text-color-secondary); outline-offset: 3px; }
.refresh-button:disabled { opacity: .65; cursor: wait; }
@media (prefers-reduced-motion: reduce) { .refresh-button { transition: none; } }
.code-subnav { padding: 0 24px 10px; border-bottom: 1px solid var(--el-border-color-lighter); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.scope-tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; background: var(--extra-light-fill); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 3px; }
.scope-tabs button { padding: 8px 12px; min-height: 38px; border-radius: 7px; color: var(--el-text-color-secondary); cursor: pointer; }
.scope-tabs button[aria-pressed="true"] { background: var(--el-bg-color); color: var(--el-color-primary); box-shadow: 0 1px 4px rgb(25 38 60 / 8%); font-weight: 600; }
.wait-button { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; padding: 6px 12px; border: 1px solid var(--el-border-color-light); border-radius: 9px; color: var(--el-text-color-regular); cursor: pointer; margin-left: auto; }
.wait-button[aria-pressed="true"] { border-color: var(--el-color-primary-light-5); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.wait-dot.checking { opacity: .5; }
.wait-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.sync-error { color: var(--el-color-danger); }
.help-toggle { padding: 8px 0 8px 8px; flex-shrink: 0; font-size: 12px; color: var(--el-text-color-secondary); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.code-help { padding: 12px 24px; line-height: 1.6; font-size: 13px; color: var(--el-text-color-regular); border-bottom: 1px solid var(--el-border-color-lighter); }
.code-scroll { flex: 1; min-height: 0; background: var(--extra-light-fill); }
.code-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 16px; padding: 20px 24px; }
.code-card { min-width: 0; padding: 18px 20px 4px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); transition: border-color var(--transition-fast); }
.code-card.copied { border-color: var(--el-color-primary); }
.code-card.stale { background: var(--extra-light-fill); }
.card-source { min-width: 0; }
.source-identity { min-width: 0; }
.source-identity h2 { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; line-height: 1.4; }
.recipient { font-size: 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; margin-top: 3px; }
.code-value-row { display: flex; align-items: center; gap: 12px; min-height: 70px; padding: 12px 0 6px; }
.code-value { min-width: 0; flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 30px; line-height: 1.25; font-weight: 650; letter-spacing: .035em; color: var(--el-color-primary); overflow-wrap: anywhere; white-space: pre-wrap; font-variant-numeric: tabular-nums; }
.code-value.hidden { font-family: inherit; font-size: 16px; letter-spacing: 0; color: var(--el-text-color-secondary); }
.copy-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; min-height: 40px; padding: 8px 10px; border-radius: 9px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-size: 13px; font-weight: 600; cursor: pointer; }
.copy-button:disabled { color: var(--el-text-color-secondary); background: var(--el-fill-color-light); cursor: default; }
.code-subject, .code-owner { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; color: var(--el-text-color-secondary); margin: 0 0 10px; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; border-top: 1px solid var(--el-border-color-lighter); }
.code-age { font-size: 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.detail-button { min-height: 40px; flex-shrink: 0; padding: 8px 0 8px 8px; font-size: 12px; color: var(--el-text-color-regular); cursor: pointer; }
.detail-button:hover { color: var(--el-color-primary); }
.new-codes { padding: 16px 24px 0; text-align: center; }
.code-empty { max-width: 420px; margin: 56px auto; padding: 0 24px; text-align: center; }
.empty-mark { width: 64px; height: 64px; display: grid; place-items: center; margin: 0 auto 16px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); border-radius: 18px; }
.code-empty h2 { font-size: 18px; font-weight: 600; }
.code-empty p { color: var(--el-text-color-secondary); line-height: 1.7; margin: 10px 0 20px; }
.code-load-error, .code-load-more { display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 16px 24px 24px; color: var(--el-text-color-secondary); }
@media (max-width: 767px) {
  .code-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto 44px; padding: 12px 16px 8px; }
  .search-input { grid-column: 1 / -1; max-width: none; }
  .status-select { width: 100%; }
  .code-toolbar :deep(.el-input__wrapper), .code-toolbar :deep(.el-select__wrapper) { min-height: 44px; }
  .code-toolbar :deep(input) { font-size: 16px; }
  .input-search, .refresh-button { min-height: 44px; }
  .refresh-button { width: 44px; height: 44px; grid-column: 3; }
  .wait-button { grid-column: 2; margin: 0; }
  .last-check, .help-label { display: none; }
  .help-mark { display: inline; }
  .help-toggle { width: 44px; font-size: 16px; padding: 0; border-radius: 8px; background: var(--extra-light-fill); text-decoration: none; }
  .code-subnav { padding: 0 16px 8px; }
  .scope-tabs button, .wait-button { min-height: 44px; }
  .scope-tabs button { padding: 6px 9px; font-size: 13px; }
  .wait-button { font-size: 13px; }
  .waiting-status { padding: 6px 16px; }
  .help-toggle { min-height: 44px; }
  .code-help { padding: 10px 16px; }
  .code-grid { padding: 12px 16px 20px; gap: 12px; }
  .code-card { padding: 16px 16px 2px; }
  .copy-button, .detail-button { min-height: 44px; }
  .code-value { font-size: 28px; }
}
</style>
