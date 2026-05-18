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
        <div class="code-item" :class="item.isStale ? 'stale' : ''" v-for="item in codes" :key="`${scope}-${item.emailId}`" @click="openDetail(item)">
          <div class="code-info">
            <div class="info-left">
              <div class="info-left-item">
                <span class="code" @click.stop="copyCode(item.code)">{{ item.code }}</span>
                <el-tag v-if="item.isStale" type="info">{{ $t('staleCode') }}</el-tag>
                <el-tag v-else type="success">{{ $t('freshCode') }}</el-tag>
              </div>
              <div class="info-left-item subject">{{ item.subject || $t('noSubject') }}</div>
              <div class="info-left-item"><span class="label">{{ $t('sender') }}:</span><span>{{ item.name || item.sendEmail || '-' }}</span></div>
              <div class="info-left-item"><span class="label">{{ $t('selectEmail') }}:</span><span>{{ item.toEmail || '-' }}</span></div>
              <div class="info-left-item" v-if="scope === 'all'"><span class="label">{{ $t('user') }}:</span><span>{{ item.userEmail || '-' }}</span></div>
              <div class="info-left-item time">{{ displayTime(item.createTime) }}</div>
            </div>
            <div class="info-right">
              <el-dropdown class="setting">
                <Icon icon="fluent:settings-24-filled" width="21" height="21" color="#909399"/>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click.stop="copyCode(item.code)">{{ $t('copyCode') }}</el-dropdown-item>
                    <el-dropdown-item @click.stop="openDetail(item)">{{ $t('details') }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
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
import {computed, defineOptions, reactive, ref, watch} from "vue";
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

async function copyCode(code) {
  await navigator.clipboard.writeText(code)
  ElMessage({message: t('copySuccessMsg'), type: 'success'})
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

getList(true)
</script>

<style scoped lang="scss">
.code-center {
  height: 100%;
  overflow: hidden;
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

.scrollbar {
  height: calc(100% - 48px);
  position: relative;
  background: var(--extra-light-fill);
}

.tabs + .scrollbar {
  height: calc(100% - 88px);
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

    &:hover {
      border-color: var(--el-color-primary-light-5);
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
}

.setting {
  cursor: pointer;
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
