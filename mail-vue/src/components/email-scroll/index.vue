<template>
  <div class="email-container">
    <div class="header-actions" :class="{'has-filters': !!$slots.first}">
      <el-checkbox
          :aria-label="t('selectAll')"
          v-model="checkAll"
          :indeterminate="isIndeterminate"
          :disabled="!emailList.length || loading"
      >
      </el-checkbox>
      <div v-if="$slots.first" class="header-filters">
        <slot name="first"></slot>
      </div>
      <div class="header-left" :style="'padding-left:' + actionLeft">
        <button type="button" class="icon reload action-icon" :aria-label="t('refreshList')" :title="t('refreshList')" @click="refresh">
          <Icon icon="ion:reload" width="18" height="18"/>
        </button>
        <slot name="actions"></slot>
        <button v-perm="'email:delete'" type="button" class="icon delete action-icon"
                :aria-label="t('delete')" :title="t('delete')" v-if="selectedCount > 0" @click="handleDelete">
          <Icon icon="uiw:delete" width="16" height="16"/>
        </button>
        <button v-perm="'email:delete'" type="button" class="icon delete action-icon"
                :aria-label="t('markAsRead')" :title="t('markAsRead')" v-if="selectedCount > 0 && showUnread" @click="handleRead">
          <Icon icon="fluent:mail-read-20-regular" width="21" height="21"/>
        </button>
      </div>

      <div class="header-right">
        <span class="email-count" v-if="total">{{ $t('emailCount', {total: total}) }}</span>
        <button v-if="showAccountIcon" type="button" class="more-icon icon action-icon"
                :aria-label="t('emailAccount')" :title="t('emailAccount')" :aria-expanded="accountShow" @click="changeAccountShow">
          <Icon icon="akar-icons:dot-grid-fill" width="16" height="16"/>
        </button>
      </div>
    </div>

    <div ref="scroll" class="scroll">
      <KeyedVirtualList ref="scrollbarRef"
                        @scroll="onScroll"
                        :list="list"
                        :options="{ itemHeight: itemHeight, overscan: 6 }"
                        :item-key="rowKey"
                        class="virtual"
                        style="height: 100%"
                        v-if="!loading && emailList.length > 0"
                        :key="keyCount"
        >
          <template #default="{ data: item, index }" >
            <!-- 不要在此加 v-memo：插槽不是 v-for，编译出的 _cache 下标是编译期常量，
                 一次渲染里每行都读写同一个槽；withMemo 只比对依赖数组、不校验 key，
                 命中就返回同一个 vnode 对象，整段列表会塌成重复行并残留孤儿 DOM -->
            <div :class="'email-row ' + props.type"
                 role="link" tabindex="0"
                 @keydown.enter.self.prevent="jumpDetails(item)"
                 :data-checked="item.checked"
                 :data-unread="showUnread && item.unread === EmailUnreadEnum.UNREAD"
                 @click="jumpDetails(item)"
                 @mouseenter="preloadEmailDetail(item)"
                 @mouseleave="cancelPreloadEmailDetail"
                 @focusin="preloadEmailDetail(item)"
                 v-if="!item.expand"
                 @contextmenu="handleContextmenu($event, item)"
                 :style="item.rightChecked ? 'background: var(--right-checked-background)' : ''"
            >
              <el-checkbox :class=" props.type === 'all-email' ? 'all-email-checkbox' : 'checkbox'"
                           :aria-label="t('select') + ' ' + item.subject"
                           v-model="item.checked" @click.stop></el-checkbox>
              <button type="button" @click.stop="starChange(item)" class="pc-star" v-if="showStar" :aria-label="t('starred')" :aria-pressed="!!item.isStar">
                <Icon v-if="item.isStar" icon="fluent-color:star-16" width="20" height="20"/>
                <Icon v-else icon="solar:star-line-duotone" width="18" height="18"/>
              </button>
              <div v-if="!showStar"></div>
              <div class="title title-column">

                <div class="email-sender" :style=" (showStatus ? 'gap: 10px;' : '') + ((item.unread === EmailUnreadEnum.UNREAD && showUnread)  ? 'font-weight: bold' : '')">
                  <div class="email-status" v-if="showStatus">
                    <el-tooltip effect="dark" :content="item.statusIcon.content">
                      <Icon :icon="item.statusIcon.icon" :style="`color: ${item.statusIcon.color}`" width="20" height="20"/>
                    </el-tooltip>
                    <div class="del-status" v-if="item.isDel">
                      <el-tooltip effect="dark" :content="item.isDelContent">
                        <Icon class="icon" icon="mdi:email-remove" width="20" height="20"/>
                      </el-tooltip>
                    </div>
                  </div>
                  <div v-else></div>
                  <span class="name">
                    <span>
                      <div class="unread" v-if="isMobile && (item.unread === EmailUnreadEnum.UNREAD && showUnread) "/>
                      <slot name="name" :email="item"> {{ item.name }}</slot>
                    </span>
                    <span>
                      <Icon v-if="item.isStar" icon="fluent-color:star-16" width="18" height="18"/>
                    </span>
                  </span>
                  <span class="phone-time">{{ item.formatCreateTime }}</span>
                </div>
                <div>
                  <div class="email-text">
                    <span class="email-subject" :style="(item.unread === EmailUnreadEnum.UNREAD && showUnread)  ? 'font-weight: bold' : ''">
                      <div class="unread" v-if="!isMobile && (item.unread === EmailUnreadEnum.UNREAD && showUnread) "/>
                      <button v-if="item.code" type="button" class="code-tag" :aria-label="t('copy') + ' ' + item.code" @click.stop="copyCode(item.code)">{{ item.code }}</button>
                      <span class="subject-text">
                        <slot name="subject" :email="item" >
                          {{ item.subject || '\u200B' }}
                        </slot>
                      </span>
                    </span>
                    <span class="email-content">{{ item.formatText || '\u200B' }}</span>
                  </div>
                  <div class="user-info" v-if="showUserInfo">
                    <div class="user">
                      <span>
                        <Icon icon="mynaui:user" width="20" height="20"/>
                      </span>
                      <span>{{ item.userEmail }}</span>
                    </div>
                    <div class="account">
                      <span>
                        <Icon icon="mdi-light:email" width="20" height="20"/>
                      </span>
                      <span>{{ item.type === 0 ? item.toEmail : item.sendEmail }}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="email-right" :style="showUserInfo ? 'align-self: start;':''">
                <span class="email-time" :style="(item.unread === EmailUnreadEnum.UNREAD && showUnread) ? 'font-weight: bold' : ''">{{ item.formatCreateTime }}</span>
              </div>
            </div>
            <skeletonBlock v-else-if="item.expand === 'loading'"
                           :rows="1"
                           :showStar="showStar"
                           :accountShow="accountShow"
                           :showStatus="showStatus"
                           :showUserInfo="showUserInfo"
                           :type="type"/>
            <div class="noLoading" v-else-if="item.expand === 'noMoreData'">
              <div>{{ $t('noMoreData') }}</div>
            </div>
          </template>
        </KeyedVirtualList>
      <skeletonBlock v-if="firstLoad && showFirstLoading"
                       :rows="20"
                       :showStar="showStar"
                       :accountShow="accountShow"
                       :showStatus="showStatus"
                       :showUserInfo="showUserInfo"
                       :type="type"/>
      <skeletonBlock v-if="loading"
                       :rows="skeletonRows"
                       :showStar="showStar"
                       :accountShow="accountShow"
                       :showStatus="showStatus"
                       :showUserInfo="showUserInfo"
                       :type="type"/>
      <div class="empty" v-if="noLoading && emailList.length === 0 && !loading && !loadError">
        <el-empty :image-size="isMobile ? 120 : null" :description="$t('noMessagesFound')"/>
      </div>
      <div class="empty" v-if="loadError && emailList.length === 0 && !loading">
        <el-empty :image-size="isMobile ? 120 : null" :description="$t('listLoadFailed')">
          <el-button type="primary" @click="refresh">{{ $t('retry') }}</el-button>
        </el-empty>
      </div>
    </div>
    <el-dropdown
        ref="dropdownRef"
        @visible-change="visibleChange"
        :virtual-ref="triggerRef"
        :show-arrow="false"
        :popper-options="{
      modifiers: [{ name: 'offset', options: { offset: [0, 0] } }],
    }"
        virtual-triggering
        trigger="contextmenu"
        placement="bottom-start"
    >
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="rightClickEmail.code" @click="copyCode(rightClickEmail.code)" >
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent-color:clipboard-24" width="20" height="20" />
                <span>{{t('copyCode')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email'].includes(props.type)" @click="emailRead(rightClickEmail.emailId)" >
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent:mail-read-20-regular" width="20" height="20" />
                <span>{{t('markAsRead')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','star'].includes(props.type)" @click="openReply(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="la:reply" width="20" height="20"  />
                <span>{{t('reply')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','send', 'star'].includes(props.type)" @click="openForward(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:arrow-up-right" width="19" height="19"  />
                <span>{{t('forward')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','send', 'star'].includes(props.type)" @click="starChange(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="solar:star-line-duotone" width="19" height="19"/>
                <span>{{t('star')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email'" @click="handleSearch('user', rightClickEmail.userEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchUser')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email' " @click="handleSearch('account', rightClickEmail.toEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchEmail')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email' " @click="handleSearch('name', rightClickEmail.name)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchSender')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item @click="rightDelete(rightClickEmail.emailId)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="uiw:delete" width="16" height="20" style="margin-left: 1px;margin-right: 3px" />
                <span>{{t('delete')}}</span>
              </div>
            </template>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup>
import {Icon} from "@iconify/vue/offline";
import skeletonBlock from "@/components/email-scroll/skeleton/index.vue"
import {computed, onActivated, onDeactivated, reactive, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import {useEmailStore} from "@/store/email.js";
import {useAccountStore} from "@/store/account.js";
import {useUiStore} from "@/store/ui.js";
import {useSettingStore} from "@/store/setting.js";
import {fromNow} from "@/utils/day.js";
import {useI18n} from "vue-i18n";
import {EmailUnreadEnum} from "@/enums/email-enum.js";
import KeyedVirtualList from "@/components/email-scroll/keyed-virtual-list.js";
import {sanitizeHtml} from "@/utils/html-sanitize.js";
import {createRequestCoordinator} from "@/components/email-scroll/request-coordinator.js";
import {
  getSessionGeneration,
  registerSessionResetter
} from "@/session/auth-session.js";
import {
  getCachedEmailDetail as readCachedEmailDetail,
  invalidateEmailDetails,
  loadEmailDetail
} from "@/components/email-scroll/email-detail-session.js";
import {createEmailDetailView} from "@/components/email-scroll/email-detail-view.js";
import {createPagePrefetchController} from "@/components/email-scroll/page-prefetch.js";
import {createActiveRuntime} from "@/components/email-scroll/active-runtime.js";
import {createEmailListScrollbarWatchSource} from "@/components/email-scroll/email-list-scrollbar-source.js";
import {createSelectionState} from "@/components/email-scroll/selection-state.js";
import {removeEmailsInPlace} from "@/components/email-scroll/email-list-mutations.js";

const props = defineProps({
  getEmailList: Function,
  getEmailDetail: Function,
  emailDelete: Function,
  emailRead: Function,
  starAdd: Function,
  starCancel: Function,
  cancelSuccess: Function,
  starSuccess: Function,
  actionLeft: {
    type: String,
    default: '0'
  },
  timeSort: {
    type: Number,
    default: 0,
  },
  showStatus: {
    type: Boolean,
    default: false
  },
  showAccountIcon: {
    type: Boolean,
    default: true,
  },
  showUserInfo: {
    type: Boolean,
    default: false
  },
  showStar: {
    type: Boolean,
    default: true
  },
  allowStar: {
    type: Boolean,
    default: true
  },
  type: {
    type: String,
    default: 'email'
  },
  showFirstLoading: {
    type: Boolean,
    default: true
  },
  showUnread: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['jump', 'refresh-before', 'delete-draft', 'right-search'])
const {t, locale} = useI18n()
const settingStore = useSettingStore()
const uiStore = useUiStore();
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const loading = ref(false);
const followLoading = ref(false);
const noLoading = ref(false);
const loadError = ref(false);
const emailList = reactive([])
const expandList = reactive([])
const total = ref(0);
const scroll = ref(null)
const firstLoad = ref(true)
let scrollTop = 0
const isArriveBottom = ref(false)
const latestEmail = ref(null)
const scrollbarRef = ref(null)
const requestCoordinator = createRequestCoordinator(getSessionGeneration)
const pagePrefetch = createPagePrefetchController()
// 最近一次加载完成、还没调度下一页预取的请求
let prefetchRequest = null
let refreshPending = false
let isMobile = ref(innerWidth < 1367)
let skeletonRows = 0
const timePaddingRight = ref('');
const keyCount = ref(0);
const dropdownRef = ref(null);
const dropdownCloseLock = ref(false);
const dropdownShow = ref(false);
const rightClickEmail = ref({});
const {selectedCount, selectedIds, checkAll, isIndeterminate} = createSelectionState(emailList);
const position = ref(
    DOMRect.fromRect({
      x: 0,
      y: 0,
    })
)
const unregisterSessionResetter = registerSessionResetter(resetEmailSessionState)

const triggerRef = ref({
  getBoundingClientRect() {
    return position.value;
  }
})

const queryParam = reactive({
  size: 50
});

defineExpose({
  refreshList,
  deleteEmail,
  addItem,
  handleList,
  emailList,
  firstLoad,
  latestEmail,
  noLoading,
  total
})

onActivated(() => {
  activeRuntime.activate()
  requestAnimationFrame(() => {
    const index = scrollTop / itemHeight.value
    scrollbarRef.value?.scrollTo(index);
  })
})

onDeactivated(() => {
  activeRuntime.deactivate()
})

function handleResize() {
  isMobile.value = window.innerWidth < 1367
}

function handleWheel() {
  if (dropdownShow.value) {
    dropdownRef.value?.handleClose?.();
  }
}

const activeRuntime = createActiveRuntime({
  intervalMs: 1000 * 60,
  onInterval: () => {
    emailList.forEach(email => {
      email.formatCreateTime = fromNow(email.createTime);
    })
  },
  listeners: [
    { target: window, type: 'resize', listener: handleResize },
    { target: window, type: 'wheel', listener: handleWheel }
  ],
  onActivate: () => {
    pagePrefetch.activate()
    if (refreshPending) getEmailList(true)
  },
  onDeactivate: () => {
    pagePrefetch.deactivate()
    clearTimeout(preloadTimer)
  }
})

onMounted(() => {
  activeRuntime.activate()
})

onUnmounted(() => {
  requestCoordinator.invalidate()
  unregisterSessionResetter()
  activeRuntime.deactivate()
  clearTimeout(preloadTimer)
})

getEmailList()

function onScroll(e) {
	const target = e.target;
	scrollTop = target.scrollTop;
	// 手写触底判断：距底 1200px 内触发预加载，替代 useScroll（省掉每帧 getComputedStyle）
	isArriveBottom.value = target.scrollHeight - target.scrollTop - target.clientHeight <= 1200
	// 用户不往下翻时预取下一页是纯开销：滚过已加载高度的 40% 才调度
	if (prefetchRequest && target.scrollTop > target.scrollHeight * 0.4) {
		const request = prefetchRequest
		prefetchRequest = null
		if (requestCoordinator.isCurrent(request)) scheduleNextPagePrefetch(request)
	}
}


const list = computed(() => {
  return [...emailList, ...expandList]
})

// 底部 loading / noMoreData 占位行的 emailId 都是 0，用 expand 区分
function rowKey(item) {
  return item.expand || item.emailId
}

const itemHeight = computed(() => {
    if (props.type === 'all-email') {
      return isMobile.value ? 132 : 65;
    } else  {
      return isMobile.value ? 83 : 48;
    }
})

watch(createEmailListScrollbarWatchSource(emailList), () => {
  updateHasScrollbar();
})

watch(scrollbarRef, () => {
  updateHasScrollbar();
})

// 强制刷新 (itemHeight 更改后虚拟滚动列表不会自己更新)
watch(itemHeight, () => {
  keyCount.value ++
})

watch(followLoading, (isFollowLoading) => {
  if (isFollowLoading) {
    expandList.push({
      emailId: 0,
      expand: 'loading'
    })
  } else {
    const index = expandList.findIndex(item => item.expand === 'loading')
    expandList.splice(index, 1);
  }
});

watch(noLoading, (isNoLoading) => {
  if (isNoLoading) {
    expandList.push({
      emailId: 0,
      expand: 'noMoreData'
    })
  } else {
    const index = expandList.findIndex(item => item.expand === 'noMoreData')
    expandList.splice(index, 1);
  }
})


// 监听是否到达底部
watch(isArriveBottom, (isBottom) => {
  if (isBottom && activeRuntime.isActive() && !loading.value) {
    loadData();
  }
});

watch(() => emailStore.deleteIds, () => {
  if (emailStore.deleteIds) {
    deleteEmail(emailStore.deleteIds)
  }
})

watch(() => emailStore.cancelStarEmailId, () => {
  emailList.forEach(email => {
    if (email.emailId === emailStore.cancelStarEmailId) {
      email.isStar = 0
    }
  })
})

watch(() => emailStore.addStarEmailId, () => {
  emailList.forEach(email => {
    if (email.emailId === emailStore.addStarEmailId) {
      email.isStar = 1
    }
  })
})

async function openReply(email) {
  const resolvedEmail = await resolveEmailDetail(email)
  if (resolvedEmail) uiStore.writerRef?.openReply(resolvedEmail)
}

async function openForward(email) {
  const resolvedEmail = await resolveEmailDetail(email)
  if (resolvedEmail) uiStore.writerRef?.openForward(resolvedEmail)
}

async function resolveEmailDetail(email) {
  if (email.content || !props.getEmailDetail) {
    return email;
  }
  const detail = await loadCachedEmailDetail(email.emailId);
  if (!detail) return null;
  return createEmailDetailView(email, detail);
}

function detailDescriptor(emailId) {
  return {
    accountId: accountStore.currentAccountId,
    sessionGeneration: getSessionGeneration(),
    emailId,
    scope: props.type === 'all-email' ? 'physics' : 'logic'
  }
}

async function loadCachedEmailDetail(emailId) {
  const requestGeneration = getSessionGeneration()
  return loadEmailDetail({
    ...detailDescriptor(emailId),
    load: signal => props.getEmailDetail(emailId, { signal })
  }).then(detail => {
    return requestGeneration === getSessionGeneration() ? detail : null
  })
}

let preloadTimer = null;

//hover 节流：停留 150ms 才预取详情，快速滑过列表不再触发批量请求
function preloadEmailDetail(email) {
  if (!props.getEmailDetail || !email?.emailId || email.content
      || readCachedEmailDetail(detailDescriptor(email.emailId)) !== undefined) {
    return;
  }

  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    loadCachedEmailDetail(email.emailId).catch(() => {});
  }, 150);
}

function cancelPreloadEmailDetail() {
  clearTimeout(preloadTimer);
}

function visibleChange(e) {
  dropdownShow.value = e;
  dropdownCloseLock.value = true;
  setTimeout(() => {
    dropdownCloseLock.value = false;
  },1500)

  if (!e && rightClickEmail.value.rightChecked) {
    rightClickEmail.value.rightChecked = false
  }
}

const handleContextmenu = (event, email) => {

  if (props.type === 'draft') {
    return
  }

  if (rightClickEmail.value.rightChecked) {
    rightClickEmail.value.rightChecked = false
  }

  const { clientX, clientY } = event
  position.value = DOMRect.fromRect({
    x: clientX,
    y: clientY,
  })
  event.preventDefault();
  dropdownRef.value?.handleOpen();

  rightClickEmail.value = email;
  rightClickEmail.value.rightChecked = true
}

function updateHasScrollbar() {
  nextTick(() => {
    // 必须取本实例的滚动容器：keep-alive 下收件箱/已发送/全部邮件等多个列表同时存在，
    // document.querySelector 只会命中 DOM 里的第一个，实例之间互相串味
    const doc = scrollbarRef.value?.$el;
    if (doc) {
      timePaddingRight.value = doc.scrollHeight > doc.clientHeight ? '5px' : '15px';
    }
  })
}

function getSkeletonRows() {
  if (emailList.length > 20) return skeletonRows = 20
  if (emailList.length === 0) return skeletonRows = 1
  skeletonRows = emailList.length
}

const accountShow = computed(() => {
  return uiStore.accountShow && settingStore.settings.manyEmail === 0
})

function htmlToText(email) {
  if (email.previewText) {
    return cleanSpace(email.previewText)
  }

  if (email.text) {
    return cleanSpace(email.text)
  }

  if (email.content) {

    const tempDiv = document.createElement('div');

    tempDiv.innerHTML = sanitizeHtml(email.content);

    // 列表仅取纯文本，但节点一旦挂进 document 就会拉取远端资源；
    // 未打开邮件就回传「已读」给发件人，所以先删掉所有会发请求的元素
    tempDiv
        .querySelectorAll('img, iframe, object, embed, video, audio, source, link, input, script, style, title')
        .forEach(el => el.remove());
    let text = tempDiv.textContent || tempDiv.innerText || '';
    text = text.replace(/\s+/g, ' ').trim();
    return cleanSpace(text)
  }

  return ''

}

function cleanSpace(text) {
  return text
      .replace(/[\u200B-\u200F\uFEFF\u034F\u200B-\u200F\u00A0\u3000\u00AD]/g, '')// 移除零宽空格
      .replace(/\s+/g, ' ')                   // 多空白合并成一个空格
      .trim();
}

function starChange(email) {

  if (!email.isStar) {

    if (!props.allowStar) return;

    email.isStar = 1;
    props.starAdd(email.emailId).then(() => {
      email.isStar = 1;
      invalidateEmailDetails({ emailIds: [email.emailId] })
      props.starSuccess(email)
    }).catch(e => {
      console.error(e)
      email.isStar = 0
    })
  } else {

    email.isStar = 0;
    props.starCancel(email.emailId).then(() => {
      email.isStar = 0;
      invalidateEmailDetails({ emailIds: [email.emailId] })
      props.cancelSuccess?.(email)
    }).catch(e => {
      console.error(e)
      email.isStar = 1;
    })
  }
}

function changeAccountShow() {
  uiStore.accountShow = !uiStore.accountShow;
}

const handleRead = () => {
  const emailIds = getSelectedMailsIds();
  props.emailRead(emailIds);
  localRead(emailIds);
  invalidateEmailDetails({ emailIds })
}

function emailRead(emailId) {
  props.emailRead([emailId])
  localRead([emailId]);
  invalidateEmailDetails({ emailIds: [emailId] })
}

function localRead(emailIds) {
  emailIds.forEach(emailId => {
    const index = emailList.findIndex(email => email.emailId === emailId);
    if (index > -1) {
      emailList[index].unread = EmailUnreadEnum.READ;
      emailList[index].checked = false;
    }
  })
}

function rightDelete(emailId) {

  if (props.type === 'all-email') {
    ElMessageBox.confirm(t('delOneEmailConfirm'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning'
    }).then(() => {
      props.emailDelete([emailId]).then(() => {
        ElMessage({
          message: t('delSuccessMsg'),
          type: 'success',
          plain: true
        })
        emailStore.deleteIds = [emailId];
      })
    })
    return;
  }
  props.emailDelete([emailId]).then(() => {
    ElMessage({
      message: t('delSuccessMsg'),
      type: 'success',
      plain: true
    })
    emailStore.deleteIds = [emailId];
  })
}

function handleSearch(type, value) {
  emit('right-search', type, value);
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true
    })
  }
}

function handleDelete() {
  ElMessageBox.confirm(t('delEmailsConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {

    if (props.type === 'draft') {
      const draftIds = getSelectedDraftsIds();
      emit('delete-draft', draftIds);
      return;
    }

    const emailIds = getSelectedMailsIds();
    props.emailDelete(emailIds).then(() => {
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true
      })
      emailStore.deleteIds = emailIds;
    })
  })
}

function deleteEmail(emailIds) {
  invalidateEmailDetails({ emailIds })
  pagePrefetch.invalidate()
  const removed = removeEmailsInPlace(emailList, emailIds);
  if (removed > 0 && total.value) {
    total.value = Math.max(0, total.value - removed);
  }
  if (emailList.length < queryParam.size && !noLoading.value) {
    getEmailList()
  }
}

function addItem(email) {
  pagePrefetch.invalidate()

  const existIndex = emailList.findIndex(item => item.emailId === email.emailId)

  if (existIndex > -1) {
    return false;
  }

  email.formatText = htmlToText(email);
  email.formatCreateTime = fromNow(email.createTime);

  if (props.timeSort) {
    if (noLoading.value) {
      handleList([email]);
      emailList.push(email);
    }

    if (email.emailId > latestEmail.value?.emailId) {
      latestEmail.value = email
    }

    total.value++
    return true;
  }


  const index = emailList.findIndex(item => item.emailId < email.emailId)

  if (index !== -1) {
    handleList([email]);
    emailList.splice(index, 0, email);
  } else {
    if (noLoading.value) {
      handleList([email]);
      emailList.push(email);
    }
  }

  if (email.emailId > latestEmail.value?.emailId) {
    latestEmail.value = email
  }

  total.value++
  return true;
}

// 获取选中的邮件列表id（复用 computed，避免重复扫描）
function getSelectedMailsIds() {
  return selectedIds.value;
}

function getSelectedDraftsIds() {
  return emailList.filter(item => item.checked).map(item => item.draftId);
}

function jumpDetails(email) {

  if (dropdownShow.value) {
    dropdownRef.value.handleClose();
    return;
  }

  if (!dropdownCloseLock.value) {
    const sel = window.getSelection();
    if (sel.toString().trim()) {
      return
    }
  }
  emit('jump', email)
}


function getEmailList(refresh = false) {
  // KeepAlive 隐藏页仍收到账号变更；失效立即执行，请求等重新进入后合并补发。
  if (refresh && !activeRuntime.isActive()) {
    refreshPending = true
    return
  }
  const request = requestCoordinator.begin();
  if (!request) return;
  if (refresh) refreshPending = false

  let emailId = emailList.length > 0 ? emailList.at(-1).emailId : 0;
  const pageKey = getPageKey(emailId);

  if (!refresh) {

    if (loading.value || noLoading.value) {
      requestCoordinator.finish(request)
      return
    }

  } else {
    getSkeletonRows()
    emailId = 0
    loading.value = true
    scrollTop = 0
  }

  if (emailList.length === 0) {
    loading.value = true
  } else {
    followLoading.value = !refresh;
  }

  // 仅首屏/刷新(无游标)取 COUNT，翻页 withTotal=0 跳过总数统计
  const withTotal = emailId === 0 ? 1 : 0;
  const dataPromise = (!refresh && pagePrefetch.consume(pageKey))
      || props.getEmailList(emailId, queryParam.size, withTotal, {withLatest: withTotal});

  dataPromise.then(async data => {
    if (!data || !requestCoordinator.isCurrent(request)) {
      return;
    }

    firstLoad.value = false
    loadError.value = false

    let list = data.list.map(item => ({
      ...item,
      checked: false
    }));


    if (refresh) {
      emailList.length = 0
    }

    if (data.latestEmail) {
      latestEmail.value = data.latestEmail
    }

    handleList(list);
    emailList.push(...list);
    if (refresh) scrollbarRef.value?.scrollTo(0);

    noLoading.value = data.hasMore === false || data.list.length < queryParam.size;
    followLoading.value = !noLoading.value;

    if (withTotal) {
      total.value = data.total;
    }
    prefetchRequest = request;
  }).catch(e => {
    if (!requestCoordinator.isCurrent(request)) {
      return;
    }
    console.error('邮件列表加载失败', e);
    // 失败时退出骨架屏并解锁翻页，错误提示由 axios 拦截器统一弹出
    firstLoad.value = false;
    followLoading.value = false;
    loadError.value = true;
  }).finally(() => {
    loading.value = false
    if (requestCoordinator.finish(request)) {
      getEmailList(true)
    }
  })
}

function getPageKey(emailId) {
  return [props.type, props.timeSort, emailId, queryParam.size].join(':');
}

function scheduleNextPagePrefetch(request) {
  if (!activeRuntime.isActive() || noLoading.value || emailList.length === 0 || !props.getEmailList) {
    return;
  }

  const nextEmailId = emailList.at(-1).emailId;
  const key = getPageKey(nextEmailId);

  pagePrefetch.schedule({
    key,
    load: signal => {
      if (!requestCoordinator.isCurrent(request)) return null
      return props.getEmailList(nextEmailId, queryParam.size, 0, { signal, withLatest: 0 })
    }
  });
}

// 状态图标表按需构建一次：每封邮件重建 Map + 8 次 t() 是纯浪费。
// 表内文案与 isDelContent 都是取值时固化的，不会随 t() 重新求值，
// 所以切换语言必须显式重建（见下方 watch(locale)）
function buildStatusIconMap() {
  return {
    0: { icon: 'ic:round-mark-email-read', color: '#51C76B', content: t('received') },
    1: { icon: 'bi:send-arrow-up-fill',  color: '#51C76B', content: t('sent') },
    2: { icon: 'bi:send-check-fill',     color: '#51C76B', content: t('delivered') },
    3: { icon: 'bi:send-x-fill',         color: '#F56C6C', content: t('bounced') },
    8: { icon: 'bi:send-x-fill',         color: '#F56C6C', content: t('bounced') },
    4: { icon: 'bi:send-exclamation-fill', color: '#FBBD08', content: t('complained') },
    5: { icon: 'bi:send-arrow-up-fill',  color: '#FBBD08', content: t('delayed') },
    7: { icon: 'ic:round-mark-email-read', color: '#FBBD08', content: t('noRecipient') },
  };
}
let statusIconMap = null;
function getStatusIconMap() {
  if (!statusIconMap) statusIconMap = buildStatusIconMap();
  return statusIconMap;
}

watch(locale, () => {
  statusIconMap = null;
  handleList(emailList);
})

function handleList(list) {
  const icons = getStatusIconMap();
  list.forEach(email => {
    email.formatText = htmlToText(email)
    email.formatCreateTime = fromNow(email.createTime);
    if (email.isDel) {
      email.isDelContent = t('selectDeleted');
    }
    email.statusIcon = icons[email.status];
  })
}

function refresh() {
  emit('refresh-before')
  refreshList()
}

function refreshList() {
  loadError.value = false;
  const canStartImmediately = requestCoordinator.invalidate({queueRefresh: true});
  invalidateEmailDetails({ emailIds: emailList.map(email => email.emailId) })
  pagePrefetch.invalidate();
  if (canStartImmediately) {
    getEmailList(true);
  }
}

function resetEmailSessionState() {
  requestCoordinator.invalidate()
  pagePrefetch.invalidate()
  prefetchRequest = null
  refreshPending = false
  clearTimeout(preloadTimer)
  emailList.length = 0
  expandList.length = 0
  latestEmail.value = null
  total.value = 0
  firstLoad.value = true
  noLoading.value = false
  loadError.value = false
  loading.value = false
  followLoading.value = false
}

function loadData() {
  getEmailList()
}

</script>
<style lang="scss" scoped>

.email-container {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  height: 100%;
}

.scroll {
  margin: 0;
  height: 100%;
  overflow: hidden;

  .virtual {
    will-change: scroll-position;
  }

  .empty {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
  }

  .noLoading {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 15px 0 0 0;
    color: var(--secondary-text-color);
  }

  .follow-loading {
    height: 60px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .loading {
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--loading-background);
    height: 100%;
    width: 100%;
    position: absolute;
    z-index: 1;
    top: 0;
    left: 0;
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
}

:deep(.email-row) {
  display: flex;
  padding: 8px 0;
  justify-content: space-between;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  align-items: center;
  position: relative;
  transition: background-color var(--transition-fast);
  height: 48px;
  @media (max-width: 1366px) {
    height: 83px;
  }

  @media (pointer: coarse) {
    /* 触屏 */
    user-select: none;
  }
  &.all-email {
    height: 65px;
    @media (max-width: 1366px) {
      height: 132px;
    }
  }
  .user-info {
    display: flex;
    flex-wrap: wrap;
    column-gap: 10px;
    margin-top: 5px;
    margin-bottom: 2px;
    color: var(--email-scroll-content-color);
    @media (max-width: 1366px) {
      flex-direction: column;
    }

    .user, .account {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 5px;
      line-height: 20px;
      max-width: 300px;
      min-width: 0;

      @media (max-width: 1223px) {
        max-width: 280px;
      }

      span:first-child { flex-shrink: 0; }
      span:last-child { overflow: hidden; text-overflow: ellipsis; }
    }
  }

  .checkbox {
    display: flex;
    padding-left: 15px;
    padding-right: 20px;
    justify-content: center;
  }

  .all-email-checkbox {
    display: flex;
    padding-left: 15px;
    padding-right: 20px;
    justify-content: center;
    @media (min-width: 1367px) {
      justify-content: start;
      height: 100%;
      align-self: start;
      padding-bottom: 30px;
    }
  }

  .title-column {
    @media (max-width: 1366px) {
      grid-template-columns: 1fr !important;
      gap: 4px !important;
    }
  }

  .title {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 16px;
    @media (max-width: 1366px) {
      padding-right: 15px;
    }
    @media (max-width: 1366px) {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .email-sender {
      color: var(--el-text-color-primary);
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;

      .email-status {
        display: flex;
        flex-direction: column;
        align-content: center;
        @media (max-width: 1366px) {
          flex-direction: row;
          gap: 5px;
        }
      }

      .name {
        display: grid;
        gap: 5px;
        grid-template-columns: auto 1fr;

        > span:last-child {
          display: flex;
          align-items: center;
        }

        @media (min-width: 1366px) {
          grid-template-columns: 1fr;
          > span:last-child {
            display: none;
          }
        }

        > span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        .name-skeleton {
          width: 150px;
          height: 1rem;
          @media (max-width: 767px) {
            width: 130px;
          }
        }
      }

      .phone-time {
        color: var(--secondary-text-color);
        font-variant-numeric: tabular-nums;
        font-weight: normal;
        font-size: 12px;
        @media (min-width: 1367px) {
          display: none;
        }
      }
    }

    .email-text-skeleton {
      .text-skeleton-one {
        width: 80%;
        height: 16px;
        @media (max-width: 1366px) {
          width: 40%;
        }
        @media (max-width: 767px) {
          width: 70%;
        }
      }

      .text-skeleton-two {
        width: min(300px, 100%);
        height: 16px;
        @media (min-width: 1367px) {
          display: none;
        }
        @media (max-width: 1366px) {
          width: 100%;
        }
      }
    }

    .email-text {
      display: grid;
      grid-template-columns: minmax(0, auto) minmax(0, 1fr);
      @media (max-width: 1366px) {
        grid-template-columns: 1fr;
      }

      .email-subject {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        white-space: nowrap;
        min-width: 0;
        @media (min-width: 1367px) {
          padding-left: 5px;
        }
      }

      .code-tag {
        flex: 0 0 auto;
        max-width: 170px;
        height: 20px;
        line-height: 20px;
        font-size: 12px;
        font-family: ui-monospace, Consolas, monospace;
        padding: 0 6px;
        border-radius: 4px;
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        cursor: pointer;
      }

      .subject-text {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .email-content {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        padding-left: 10px;
        color: var(--email-scroll-content-color);
        @media (max-width: 1366px) {
          padding-left: 0;
          margin-top: 0;
        }
      }
    }
  }


  .email-right {
    color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums;
    text-align: right;
    font-size: 12px;
    white-space: nowrap;
    display: flex;
    padding-left: 15px;
    align-items: center;
    @media (max-width: 1366px) {
      display: none;
    }
  }

  .email-right-skeleton {
    @media (max-width: 1366px) {
      display: none;
    }
  }

  &[data-unread="true"] { background: var(--extra-light-fill); }
  &:focus-visible { outline-offset: -2px; }

  &:hover {
    background-color: var(--email-hover-background);
    z-index: 0;
  }

  /* 勾选行给出明确但不刺眼的选中态 */
  &[data-checked="true"],
  &[data-checked="true"]:hover {
    background-color: var(--el-color-primary-light-9);
  }
}


.phone-star {
  display: none;
}

.pc-star {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  flex-shrink: 0;
  width: 40px;
  color: var(--secondary-text-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  &:hover { color: var(--el-color-primary); background: var(--base-fill); }
}

@media (max-width: 1366px) {
  .pc-star {
    display: none;
  }
  .phone-star {
    display: block;
    align-self: end;
    padding-right: 16px;
    padding-top: 8px;
  }
  .star-pd {
    padding-top: 6px !important;
  }
}

.email-time {
  padding-right: v-bind(timePaddingRight);
}

:deep(.el-scrollbar__view) {
  height: 100%;
}

.header-actions {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: 'select actions meta';
  align-items: center;
  gap: 15px;
  padding: 3px 15px;
  box-shadow: var(--header-actions-border);

  &.has-filters {
    grid-template-columns: auto minmax(0, 394px) minmax(max-content, 1fr) auto;
    grid-template-areas: 'select filters actions meta';
  }

  > .el-checkbox { grid-area: select; }

  .header-left {
    grid-area: actions;
    display: flex;
    align-items: center;
    min-width: 0;
    padding-left: 2px;
    color: var(--regular-text-color);
  }

  .header-filters {
    grid-area: filters;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    min-width: 0;
    gap: 12px;
  }

  .header-right {
    grid-area: meta;
    display: grid;
    grid-template-columns: auto auto;
    align-items: center;
    height: 100%;
    color: var(--regular-text-color);

    .email-count {
      white-space: nowrap;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--secondary-text-color);
    }
  }

  .icon {
    font-size: 18px;
    cursor: pointer;
  }

  /* Slot buttons use the same fixed touch target as the built-in actions. */
  :deep(.action-icon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 40px;
    width: 40px;
    height: 40px;
    padding: 0;
    color: inherit;
    border-radius: var(--radius-sm);
    outline-offset: -2px;
    transition: background-color var(--transition-fast), color var(--transition-fast);
    &:hover { background: var(--light-fill); color: var(--el-color-primary); }
  }

  :deep(.action-icon:focus-visible) {
    outline: 2px solid var(--el-color-primary);
  }

  @media (max-width: 767px) {
    gap: 8px;

    &.has-filters {
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas: 'filters filters filters' 'select actions meta';
    }

    .header-filters {
      gap: 8px;
    }
  }

  .more-icon {
    margin-left: 4px;
  }
}

.del-status {
  color: var(--el-color-info);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  bottom: 1px;
}



.right-dropdown-item {
  display: flex;
  gap: 10px;
}

:deep(.el-dropdown-menu__item:last-child) {
  padding-bottom: 10px;
}

:deep(.el-dropdown-menu__item:first-child) {
  padding-top: 10px;
}

:deep(.el-dropdown-menu__item) {
  padding-right: 14px;
  padding-left: 14px;
}

.unread {
  height: 6px;
  width: 6px;
  background: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-9);
  margin-bottom: 2px;
  margin-right: 5px;
  border-radius: 50%;
  display: inline-block;
  justify-content: center;
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

</style>
