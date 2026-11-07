<template>
  <emailScroll ref="scroll"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :getEmailDetail="emailDetail"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               :time-sort="params.timeSort"
               :email-read="emailRead"
               :show-unread="true"
               actionLeft="4px"
               @jump="jumpContent"
  >
    <template #actions>
      <button type="button" class="icon action-icon" :aria-label="$t('order')" :title="$t('order')" @click="changeTimeSort">
        <Icon :icon="params.timeSort === 0 ? 'material-symbols-light:timer-arrow-down-outline' : 'material-symbols-light:timer-arrow-up-outline'" width="28" height="28"/>
      </button>
    </template>

  </emailScroll>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDelete, emailDetail, emailLatest, emailRead} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, h, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch} from "vue";
import {sleepUntil, waitUntilVisible} from "@/utils/time-utils.js";
import {createPollBackoff, trackUserActivity} from "@/utils/poll-backoff.js";
import {createActiveTask} from "@/utils/active-task.js";
import router from "@/router/index.js";
import {Icon} from "@iconify/vue/offline";
import { useRoute } from 'vue-router'

defineOptions({
  name: 'email'
})

const route = useRoute();
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const scroll = ref({})
const params = reactive({
  timeSort: 0,
})

onMounted(() => {
  emailStore.emailScroll = scroll;
})

// 组件卸载(如登出)时终止轮询循环，避免重复登录后累积多个常驻循环
const latestTask = createActiveTask(latest)
onActivated(() => latestTask.activate())
onDeactivated(() => latestTask.deactivate())
onUnmounted(() => {
  latestTask.deactivate()
})

watch(() => accountStore.currentAccountId, () => {
  existIds.clear();
  scroll.value.refreshList();
})

function changeTimeSort() {
  params.timeSort = params.timeSort ? 0 : 1
  scroll.value.refreshList();
}

function jumpContent(email) {
  emailStore.contentData.email = email
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showUnread = true
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push('/message')
}

const existIds = new Set();

// 没有新邮件时逐步放慢轮询；用户操作、切回或聚焦页面、收到新邮件时立即恢复设置的间隔
async function latest(signal) {
  const backoff = createPollBackoff()
  const stopTracking = trackUserActivity(() => backoff.activity())
  try {
    await pollLatest(signal, backoff)
  } finally {
    stopTracking()
  }
}

async function pollLatest(signal, backoff) {
  while (!signal.aborted) {

    let autoRefresh = settingStore.settings.autoRefresh;
    //自动刷新关闭时拉长空转间隔
    if (!await waitUntilVisible(signal)) return
    if (!await backoff.wait(autoRefresh > 1 ? autoRefresh * 1000 : 30000, signal)) return

    //页面在后台时暂停轮询
    if (!await waitUntilVisible(signal)) return

    if (signal.aborted) {
      return;
    }

    if (route.name !== 'email') {
      continue;
    }

    const latestId = scroll.value.latestEmail?.emailId

    if (!scroll.value.firstLoad && autoRefresh > 1) {
      try {
        const accountId = accountStore.currentAccountId
        const allReceive = scroll.value.latestEmail?.allReceive
        const curTimeSort = params.timeSort
        let list = []

        //确保发起请求时最后一个邮件是当前账号的,或者
        if (accountId === scroll.value.latestEmail?.reqAccountId) {
          list = await emailLatest(latestId, accountId, allReceive, {signal});
          backoff.settle(list.length)
        }

        //确保请求回来后，账号没有切换，时间排序没有改变，全部邮件类型没变
        if (accountId === accountStore.currentAccountId && params.timeSort === curTimeSort && allReceive === accountStore.currentAccount.allReceive) {
          if (list.length > 0) {

            for (let email of list) {

              email.reqAccountId = accountId;
              email.allReceive = allReceive;

              if (!existIds.has(email.emailId)) {

                existIds.add(email.emailId)
                scroll.value.addItem(email)

                if (!await sleepUntil(50, signal)) return
              }

            }

          }

        }
      } catch (e) {
        if (signal.aborted) return
        backoff.settle(0)
        if (e.code === 401 || e.code === 403) {
          settingStore.settings.autoRefresh = 0;
        }
        console.error(e)
      }
    }
  }
}

function addStar(email) {
  emailStore.starScroll?.addItem(email)
}

function cancelStar(email) {
  emailStore.starScroll?.deleteEmail([email.emailId])
}

function getEmailList(emailId, size, withTotal = 1, options) {
  const accountId =  accountStore.currentAccountId;
  const allReceive = accountStore.currentAccount.allReceive;
  return emailList(accountId, allReceive, emailId, params.timeSort, size, 0, withTotal, options).then(data => {
    if (data.latestEmail) {
      data.latestEmail.reqAccountId = accountId;
      data.latestEmail.allReceive = allReceive;
    }
    return data;
  })
}

</script>
<style>
.icon {
  cursor: pointer;
}
</style>
