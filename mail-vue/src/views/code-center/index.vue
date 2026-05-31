<template>
  <div class="code-center">
    <div class="header-actions">
      <div class="search">
        <el-input v-model="params.query" class="search-input" :placeholder="$t('searchCodeDesc')" @keyup.enter="search"/>
      </div>
      <el-select v-model="params.stale" class="status-select">
        <el-option :label="$t('freshCode')" value="fresh"/>
        <el-option :label="$t('all')" value="all"/>
        <el-option :label="$t('staleCode')" value="stale"/>
      </el-select>
      <Icon class="icon" icon="iconoir:search" @click="search" width="20" height="20"/>
      <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
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
            tabindex="0"
            @click="copyCode(item)"
            @keydown.enter="copyCode(item)"
            @keydown.space.prevent="copyCode(item)"
        >
          <div class="code-info">
            <div class="info-left">
              <div class="info-left-item">
                <span class="code" @click.stop="copyCode(item)">{{ item.code }}</span>
                <el-tag v-if="item.isStale" type="info">{{ $t('staleCode') }}</el-tag>
                <el-tag v-else type="success">{{ $t('freshCode') }}</el-tag>
                <el-tag v-if="copiedEmailId === item.emailId" type="primary">{{ $t('copied') }}</el-tag>
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
      <div class="load-more" v-if="codes.length > 0">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">{{ $t('loadMore') }}</el-button>
        <span v-else>{{ $t('noMoreData') }}</span>
      </div>
      <div class="empty" v-if="codes.length === 0 && !first">
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
const copiedEmailId = ref(0)
let copyTimer = 0
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

function requestList(requestParams) {
  return scope.value === 'all' ? codeAllList(requestParams) : codeList(requestParams)
}

function search() {
  refresh()
}

function refresh() {
  params.emailId = 0
  hasMore.value = false
  getList(true)
}

function loadMore() {
  if (!hasMore.value || loading.value || loadingMore.value || codes.length === 0) return
  params.emailId = codes.at(-1).emailId
  getList(false)
}

function getList(refreshList = false) {
  if (loading.value) return
  loading.value = refreshList
  loadingMore.value = !refreshList
  requestList({...params}).then(data => {
    if (refreshList) codes.length = 0
    codes.push(...data.list)
    hasMore.value = data.hasMore
    first.value = false
  }).finally(() => {
    loading.value = false
    loadingMore.value = false
  })
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
  const code = typeof item === 'string' ? item : item?.code
  if (!code) return

  try {
    await writeClipboard(code)
    copiedEmailId.value = typeof item === 'object' ? item.emailId : 0
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
  return time ? time.replace('T', ' ').slice(0, 16) : '-'
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

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})

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
  gap: 18px;
  flex-wrap: wrap;
  align-items: center;
  box-shadow: inset 0 -1px 0 0 rgba(100, 121, 143, 0.12);
  font-size: 18px;

  .search-input {
    width: min(260px, calc(100vw - 170px));
  }

  .status-select {
    width: 110px;
  }

  .icon {
    cursor: pointer;
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
  padding: 8px 15px;
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
  padding: 15px 15px 10px 15px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 15px;

  .code-item {
    background: var(--el-bg-color);
    border-radius: 8px;
    border: 1px solid var(--el-border-color);
    transition: all 200ms;
    padding: 15px;
    cursor: pointer;

    &.stale {
      opacity: 0.62;
    }

    &.copied {
      border-color: var(--el-color-primary);
      box-shadow: 0 0 0 1px var(--el-color-primary-light-7);
    }

    &:hover {
      border-color: var(--el-color-primary-light-5);
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
      font-size: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
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
  background: var(--loadding-background);
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
</style>
