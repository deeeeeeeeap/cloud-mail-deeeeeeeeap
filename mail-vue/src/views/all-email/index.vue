<template>
  <div class="email-list-box">
    <emailScroll ref="sysEmailScroll"
                 :get-emailList="getEmailList"
                 :get-email-detail="allEmailDetail"
                 :email-delete="allEmailDelete"
                 :star-add="starAdd"
                 :star-cancel="starCancel"
                 :show-star="false"
                 show-user-info
                 show-status
                 actionLeft="4px"
                 :show-account-icon="false"
                 :time-sort="params.timeSort"
                 :item-height="65"
                 @jump="jumpContent"
                 @refresh-before="refreshBefore"
                 @right-search="rightSearch"
                 :type="'all-email'"

    >
      <template #first>
        <div class="mail-search-field">
          <UiSelect v-model="params.searchType" class="search-kind-select" :aria-label="$t('select')"
            :options="searchOptions" :placeholder="$t('select')"/>
          <el-input v-model="searchValue" :placeholder="$t('searchByContent')" class="search-input"
            @keyup.enter="search"/>
        </div>
        <el-select v-model="params.type" placeholder="Select" class="status-select" @change="typeSelectChange">
          <el-option key="1" :label="$t('all')" value="all"/>
          <el-option key="3" :label="$t('received')" value="receive"/>
          <el-option key="2" :label="$t('sent')" value="send"/>
          <el-option key="4" :label="$t('selectDeleted')" value="delete"/>
          <el-option key="noone" :label="$t('noRecipientTitle')" value="noone"/>
        </el-select>
      </template>
      <template #actions>
        <button type="button" class="icon action-icon" :aria-label="$t('searchByContent')" :title="$t('searchByContent')" @click="search">
          <Icon icon="iconoir:search" width="20" height="20"/>
        </button>
        <button type="button" class="icon action-icon" :aria-label="$t('order')" :title="$t('order')" @click="changeTimeSort">
          <Icon :icon="params.timeSort === 0 ? 'material-symbols-light:timer-arrow-down-outline' : 'material-symbols-light:timer-arrow-up-outline'" width="28" height="28"/>
        </button>
        <button type="button" class="icon action-icon" :aria-label="$t('clearEmail')" :title="$t('clearEmail')" @click="openBathDelete">
          <Icon icon="fluent:broom-sparkle-16-regular" width="22" height="22"/>
        </button>
      </template>
    </emailScroll>
    <el-dialog v-model="showBathDelete" :title="$t('clearEmail')" width="335"
               @closed="closedClear">
      <div class="clear-email">
        <el-input v-model="clearParams.sendName" :placeholder="$t('sender')"/>
        <el-input v-model="clearParams.subject" :placeholder="$t('subject')"/>
        <el-input v-model="clearParams.sendEmail" :placeholder="$t('sendEmailAddress')"/>
        <el-input v-model="clearParams.toEmail" :placeholder="$t('toEmail')"/>
        <el-date-picker popper-class="my-date-picker"
                        v-model="clearTime"
                        type="daterange"
                        :teleported="false"
                        unlink-panels
                        :range-separator="t('to')"
                        size="default"
        />
        <div class="clear-button">
          <el-select v-model="clearParams.type" style="width: 200px">
            <el-option key="eq" :label="t('equal')" value="eq"/>
            <el-option key="left" :label="t('leading')" value="left"/>
            <el-option key="include" :label="t('include')" value="include"/>
          </el-select>
          <el-button :loading="clearLoading" type="primary" @click="batchDelete">{{ t('clear') }}</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import UiSelect from "@/components/ui-select/index.vue";
import {starAdd, starCancel} from "@/request/star.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {computed, defineOptions, reactive, ref, watch, onActivated, onDeactivated, onUnmounted} from "vue";
import {useEmailStore} from "@/store/email.js";
import {
  allEmailList,
  allEmailDelete,
  allEmailBatchDelete,
  allEmailLatest,
  allEmailDetail
} from "@/request/all-email.js";
import {Icon} from "@iconify/vue";
import router from "@/router/index.js";
import {useI18n} from 'vue-i18n';
import {toUtc} from "@/utils/day.js";
import {sleepUntil, waitUntilVisible} from "@/utils/time-utils.js";
import {createActiveTask} from "@/utils/active-task.js";
import {useSettingStore} from "@/store/setting.js";
import { useRoute } from 'vue-router'

defineOptions({
  name: 'all-email'
})

const route = useRoute()
const {t} = useI18n();
const emailStore = useEmailStore();
const settingStore = useSettingStore();
const clearTime = ref('')
const sysEmailScroll = ref({})
const searchValue = ref('')
const showBathDelete = ref(false)
const clearLoading = ref(false)


const params = reactive({
  timeSort: 0,
  type: 'receive',
  userEmail: null,
  accountEmail: null,
  name: null,
  subject: null,
  searchText: null,
  searchType: 'name'
})

const clearParams = reactive({
  subject: '',
  sendEmail: '',
  sendName: '',
  startTime: '',
  toEmail: '',
  endTime: '',
  type: 'eq',
})

function resetClearParams() {
  clearParams.subject = ''
  clearParams.sendEmail = ''
  clearParams.sendName = ''
  clearParams.startTime = ''
  clearParams.toEmail = ''
  clearParams.endTime = ''
}

function closedClear() {
  resetClearParams()
  clearParams.type = 'eq'
  clearParams.endTime = ''
  clearTime.value = null
}

const searchOptions = computed(() => [
  {value: 'name', label: t('sender')},
  {value: 'subject', label: t('subject')},
  {value: 'user', label: t('user')},
  {value: 'account', label: t('selectEmail')},
  {value: 'content', label: t('searchByContent')}
])

const paramsStar = localStorage.getItem('all-email-params')
if (paramsStar) {
  const locaParams = JSON.parse(paramsStar)
  params.type = locaParams.type
  params.timeSort = locaParams.timeSort
  params.status = locaParams.status
  params.searchType = locaParams.searchType
}

watch(() => params, () => {
  localStorage.setItem('all-email-params', JSON.stringify(params))
}, {
  deep: true
})

function openBathDelete() {
  showBathDelete.value = true
}

function batchDelete() {

  if (clearTime.value) {
    clearParams.startTime = toUtc(clearTime.value[0]).format("YYYY-MM-DD HH:mm:ss")
    clearParams.endTime = toUtc(clearTime.value[1]).add(1, 'day').format("YYYY-MM-DD HH:mm:ss")
  }

  if (!clearParams.sendEmail && !clearParams.sendName && !clearParams.subject && !clearParams.toEmail && !clearTime.value) {
    showBathDelete.value = false
    return
  }

  ElMessageBox.confirm(
      t('delAllConfirm'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning',
      }
  ).then(() => {
    clearLoading.value = true

    allEmailBatchDelete(clearParams).then(() => {
      ElMessage({
        message: t('clearSuccess'),
        type: "success",
        plain: true
      })
      resetClearParams()
      sysEmailScroll.value.refreshList();
    }).finally(() => {
      clearLoading.value = false
    })
  })
}

function rightSearch(type, value) {
  params.searchType = type;
  searchValue.value = value;
  search();
}

function refreshBefore() {
  searchValue.value = null
  params.timeSort = 0
  params.type = 'receive'
  params.userEmail = null
  params.accountEmail = null
  params.name = null
  params.subject = null
  params.searchText = null
  params.searchType = 'name'
}

function search() {

  params.userEmail = null
  params.accountEmail = null
  params.name = null
  params.subject = null
  params.searchText = null

  if (params.searchType === 'user') {
    params.userEmail = searchValue.value
  }

  if (params.searchType === 'account') {
    params.accountEmail = searchValue.value
  }

  if (params.searchType === 'name') {
    params.name = searchValue.value
  }

  if (params.searchType === 'subject') {
    params.subject = searchValue.value
  }

  if (params.searchType === 'content') {
    params.searchText = searchValue.value
  }

  sysEmailScroll.value.refreshList();
}

function changeTimeSort() {
  params.timeSort = params.timeSort ? 0 : 1
  search()
}

function typeSelectChange() {
  search()
}

function jumpContent(email) {
  emailStore.contentData.email = email
  emailStore.contentData.delType = 'physics'
  emailStore.contentData.showStar = false
  emailStore.contentData.showReply = false
  router.push({name: 'content'})
}


function getEmailList(emailId, size, withTotal = 1, options) {
  return allEmailList({
    emailId,
    size,
    withTotal,
    withLatest: options?.withLatest ?? 1,
    ...params
  }, options)
}

// 组件卸载(如登出)时终止轮询循环，避免重复登录后累积多个常驻循环
const latestTask = createActiveTask(latest)
onActivated(() => latestTask.activate())
onDeactivated(() => latestTask.deactivate())
onUnmounted(() => {
  latestTask.deactivate()
})

async function latest(signal) {

  while (!signal.aborted) {

    let autoRefresh = settingStore.settings.autoRefresh;

    //自动刷新关闭时拉长空转间隔
    if (!await waitUntilVisible(signal)) return
    if (!await sleepUntil(autoRefresh > 1 ? autoRefresh * 1000 : 30000, signal)) return

    //页面在后台时暂停轮询
    if (!await waitUntilVisible(signal)) return

    if (signal.aborted) {
      return;
    }

    const latestId = sysEmailScroll.value.latestEmail?.emailId

    if (autoRefresh < 2) {
      continue
    }

    if (!latestId && latestId !== 0) {
      continue
    }

    if (route.name !== 'all-email') {
      continue
    }


    if (params.type !== 'receive') {
      continue
    }

    try {

      const curTimeSort = params.timeSort
      let list = await allEmailLatest(latestId, {signal})

      if (list.length === 0) {
        continue
      }

      if (params.type !== 'receive') {
        continue
      }

      // 确保回来之后条件没变
      if (params.timeSort !== curTimeSort) {
        continue
      }

      for (let email of list) {

        sysEmailScroll.value.addItem(email)
        if (!await sleepUntil(50, signal)) return

      }

    } catch (e) {
      if (signal.aborted) return
      if (e.code === 401 || e.code === 403) {
        settingStore.settings.autoRefresh = 0;
      }
      console.error(e)
    }

  }
}

</script>
<style>

/* 手机端范围选择器：双月面板从左右并排改为上下堆叠，
   避免窄屏下两个面板互相挤压、表头错位遮挡 */
@media (max-width: 767px) {
  .my-date-picker .el-picker-panel__body {
    display: flex;
    flex-direction: column;
    min-width: 0 !important;
  }

  .my-date-picker .el-date-range-picker {
    width: min(322px, calc(100vw - 40px)) !important;
  }

  .my-date-picker .el-date-range-picker__content {
    width: 100% !important;
    float: none !important;
  }

  .my-date-picker .el-date-range-picker__content.is-left {
    border-right: 0 !important;
    border-bottom: 1px solid var(--el-border-color-light);
  }
}

</style>
<style scoped lang="scss">
.email-list-box {
  height: 100%;
  width: 100%;
  overflow: hidden;
}


.search {
  padding-top: 5px;
  padding-bottom: 5px;
}



:deep(.header-actions) {
  padding-top: 8px;
  padding-bottom: 8px;
}

.mail-search-field { display: flex; align-items: center; gap: 8px; min-width: 0; width: min(100%, 360px); }
.mail-search-field .search-kind-select { flex: 0 0 112px; --ui-select-height: 36px; }
.mail-search-field .search-input { flex: 1; }
@media (pointer: coarse) {
  .mail-search-field .search-input { height: 44px; }
}
.search-input {
  width: 100%;
  max-width: none;
  min-width: 0;
  height: 36px;
}

.clear-email {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.clear-button {
  display: flex;
  align-items: center;
  gap: 15px;

  .el-button {
    width: 100%;
  }
}

.status-select {
  margin-bottom: 2px;
  width: 102px;

  :deep(.el-select__wrapper) {
    min-height: 28px;
  }
}

.input-with-select {
  max-width: 200px;
  border-radius: 0 4px 4px 0;
}

:deep(.input-with-select .el-input-group__append) {
  background-color: var(--el-fill-color-blank);
}

:deep(.el-select__wrapper) {
  padding: 2px 10px;
  min-height: 36px;
}

@media (max-width: 767px) {
  .search-input {
    max-width: none;
    min-width: 0;
  }
}

:deep(.el-date-editor.el-input__wrapper) {
  width: 303px;
}

.icon {
  cursor: pointer;
}
</style>
