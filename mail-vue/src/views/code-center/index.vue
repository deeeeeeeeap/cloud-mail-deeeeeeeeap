<template>
  <div class="code-center">
    <div class="header-actions">
      <div class="search">
        <el-input v-model="params.query" class="search-input" :placeholder="$t('searchCodeDesc')" @keyup.enter="search"/>
      </div>
      <el-select v-model="params.stale" class="status-select" @change="refresh">
        <el-option :label="$t('freshCode')" value="fresh"/>
        <el-option :label="$t('all')" value="all"/>
        <el-option :label="$t('staleCode')" value="stale"/>
      </el-select>
      <button class="icon" type="button" :aria-label="$t('search')" @click="search"><Icon icon="iconoir:search" width="20" height="20"/></button>
      <button class="icon" type="button" :aria-label="$t('refreshList')" @click="refresh"><Icon icon="ion:reload" width="18" height="18"/></button>
    </div>

    <div class="code-help">{{ $t('codeCenterHint') }}</div>

    <div class="tabs" v-if="canViewAll">
      <el-tabs v-model="scope" @tab-change="refresh">
        <el-tab-pane :label="$t('myCodes')" name="mine"/>
        <el-tab-pane :label="$t('allCodes')" name="all"/>
      </el-tabs>
    </div>

    <el-scrollbar class="scrollbar">
      <div class="loading" :class="loading ? 'loading-show' : 'loading-hide'" :style="first ? 'background: transparent' : ''">
        <Loading/>
      </div>
      <div class="code-box">
        <div
            class="code-item"
            :class="{stale: item.isStale, copied: copiedEmailId === item.emailId}"
            v-for="item in codes"
            :key="`${scope}-${item.emailId}`"
            role="button"
            :aria-label="$t('copy') + ' ' + displayCode(item)"
            :aria-disabled="item.isStale || !item.code"
            tabindex="0"
            @click="copyCode(item)"
            @keydown.enter="copyCode(item)"
            @keydown.space.prevent="copyCode(item)"
        >
          <div class="code-info">
            <div class="info-left">
              <div class="info-left-item">
                <button type="button" class="code" :class="{hidden: item.isStale || !item.code}" :disabled="item.isStale || !item.code" :aria-label="$t('copyCode') + ': ' + displayCode(item)" @click.stop="copyCode(item)">{{ displayCode(item) }}</button>
                <el-tag v-if="copiedEmailId === item.emailId" type="primary" role="status">{{ $t('copied') }}</el-tag>
              </div>
              <div class="info-left-item code-meta" :class="item.isStale ? 'expired' : ''">{{ codeStatusText(item) }}</div>
              <div class="info-left-item subject">{{ item.subject || $t('noSubject') }}</div>
              <div class="info-left-item"><span class="label">{{ $t('sender') }}:</span><span>{{ item.name || item.sendEmail || '-' }}</span></div>
              <div class="info-left-item"><span class="label">{{ $t('selectEmail') }}:</span><span>{{ item.toEmail || '-' }}</span></div>
              <div class="info-left-item" v-if="scope === 'all'"><span class="label">{{ $t('user') }}:</span><span>{{ item.userEmail || '-' }}</span></div>
              <div class="info-left-item time">{{ displayTime(item.createTime) }}</div>
            </div>
            <div class="info-right">
              <el-button class="detail-button" text @click.stop="openDetail(item)" @keydown.enter.stop @keydown.space.stop>{{ $t('details') }}</el-button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="loadFailed" class="load-error" role="alert">
        <span>{{ $t('listLoadFailed') }}</span>
        <el-button :loading="loading || loadingMore" @click="getList(retryRefresh)">{{ $t('retry') }}</el-button>
      </div>
      <div class="load-more" v-if="codes.length > 0">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">{{ $t('loadMore') }}</el-button>
        <span v-else>{{ $t('noMoreData') }}</span>
      </div>
      <div class="empty" v-if="codes.length === 0 && !first && !loadFailed">
        <el-empty :description="$t('noVerificationCodeFound')"/>
      </div>
    </el-scrollbar>
  </div>
</template>

<script setup>
import {computed, defineOptions, onBeforeUnmount, reactive, ref, watch} from "vue";
import {Icon} from "@iconify/vue";
import {ElMessage} from "element-plus";
import router from "@/router/index.js";
import Loading from "@/components/loading/index.vue";
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

function requestList(requestScope, requestParams) {
  return requestScope === 'all' ? codeAllList(requestParams) : codeList(requestParams)
}

function search() {
  refresh()
}

function refresh() {
  return getList(true)
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
  const requestedAt = Date.now()
  loading.value = refreshList
  loadingMore.value = !refreshList
  loadFailed.value = false
  retryRefresh = refreshList
  try {
    const data = await requestList(requestScope, requestParams)
    if (requestId !== requestSeq || requestScope !== scope.value) return
    if (refreshList) codes.length = 0
    codes.push(...(data.list || []).map(item => {
      // Use the server's remaining window, with request latency deducted; local clock offsets cancel out.
      const seconds = Number(item.expiresInSeconds ?? (item.expiresInMinutes ?? 0) * 60)
      return {...item, expiresAt: requestedAt + (Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0)}
    }))
    updateExpiry()
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
    ElMessage({message: t('copySuccessMsg'), type: 'success'})
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
  if (item.isStale) {
    return t('codeExpiredHint')
  }
  const minutes = Number(item.expiresInMinutes)
  if (Number.isFinite(minutes)) {
    return t('codeExpiresIn', {minutes: Math.max(1, Math.ceil(minutes))})
  }
  return t('freshCode')
}

function displayCode(item) {
  if (item.isStale || !item.code) {
    return t('codeExpiredHidden')
  }
  return item.code
}

onBeforeUnmount(() => {
  requestSeq++
  if (copyTimer) clearTimeout(copyTimer)
  clearTimeout(expiryTimer)
  document.removeEventListener('visibilitychange', updateExpiry)
})

document.addEventListener('visibilitychange', updateExpiry)
getList(true)
</script>

<style scoped lang="scss">
.code-center {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.header-actions {
  padding: 9px 15px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  box-shadow: inset 0 -1px 0 0 rgba(100, 121, 143, 0.12);
  font-size: 18px;

  // 让输入框吃掉这一行的剩余空间，不要再按 100vw 减一个写死的预留量算宽度：
  // 那个预留量没有算上下拉框、图标和它们之间的间距，窄屏下就会顶出一行去
  .search {
    flex: 1 1 0;
    min-width: 120px;
  }

  .search-input {
    width: 100%;
    max-width: 260px;
  }

  .status-select {
    width: 110px;
    flex-shrink: 0;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--regular-text-color);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--transition-fast), transform var(--transition-fast);

    &:hover {
      color: var(--el-color-primary);
    }

    &:active {
      transform: scale(0.92);
    }
  }
}

.tabs {
  padding: 0 15px;
  box-shadow: inset 0 -1px 0 0 rgba(100, 121, 143, 0.08);

  :deep(.el-tabs__header) {
    margin: 0;
  }
}

.code-help {
  flex-shrink: 0;
  padding: 12px 24px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.4;
  background: var(--el-bg-color);
  box-shadow: inset 0 -1px 0 0 rgba(100, 121, 143, 0.08);
}

.scrollbar {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--extra-light-fill);
}

.code-box {
  padding: 24px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 16px;

  .code-item {
    background: var(--el-bg-color);
    border-radius: var(--radius-lg);
    border: 1px solid var(--el-border-color);
    box-shadow: var(--shadow-card);
    transition: border-color var(--transition-base), box-shadow var(--transition-base),
      opacity var(--transition-base);
    padding: 22px;
    cursor: pointer;

    &.stale {
      background: var(--extra-light-fill);
      box-shadow: none;
    }

    &.copied {
      border-color: var(--el-color-primary);
      box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
    }

    &:hover {
      border-color: var(--el-color-primary-light-5);
      box-shadow: var(--shadow-card-hover);

    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary-light-5);
      outline-offset: 2px;
    }
  }

  .code-info {
    display: flex;
  }

  .info-left {
    flex: 1;
    min-width: 0;
  }

  .info-left-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 7px;
    min-width: 0;

    > span:last-child {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .code {
      font-weight: bold;
      font-size: 32px;
      line-height: 1.4;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.06em;
      color: var(--el-color-primary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;

      &.hidden {
        font-size: 18px;
        font-family: inherit;
        letter-spacing: normal;
        color: var(--el-text-color-secondary);
        cursor: default;
      }
    }

    .label {
      color: var(--el-text-color-secondary);
      flex-shrink: 0;
    }
  }

  .info-left-item:first-child {
    padding-top: 0;
  }

  .subject {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px dashed var(--el-border-color);
    font-weight: 500;
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .time {
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }

  .code-meta {
    color: var(--el-color-success-dark-2);
    font-size: 13px;

    &.expired {
      color: var(--el-text-color-secondary);
    }
  }
}

.info-right {
  flex-shrink: 0;
  padding-left: 10px;
}

.detail-button {
  padding: 2px 4px;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-color-primary);
  }
}

.load-more {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 5px 0 20px;
  color: var(--el-text-color-secondary);
}

.load-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  color: var(--el-text-color-secondary);
}

.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--loading-background);
  z-index: 2;
}

.loading-show {
  transition: all 200ms ease 200ms;
  opacity: 1;
}

.loading-hide {
  pointer-events: none;
  transition: var(--loading-hide-transition);
  opacity: 0;
}
@media (max-width: 767px) {
  .code-box { padding: 16px; }
  .code-help { padding: 12px 16px; }
}
</style>
