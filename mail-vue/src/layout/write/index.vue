<template>
  <div class="send" v-show="show">
    <div class="write-box">
      <div class="title">
        <div class="title-left">
          <span class="title-text">
            <Icon icon="hugeicons:quill-write-01" width="28" height="28"/>
          </span>
          <span class="sender">{{ $t('sender') }}:</span>
          <span class="sender-name">{{ form.name }}</span>
          <span class="send-email"><{{ form.sendEmail }}></span>
        </div>
        <button type="button" :disabled="sending || savingDraft" class="close-writer" :aria-label="$t('closeWindow')" @click="close">
          <Icon icon="material-symbols-light:close-rounded" width="22" height="22"/>
        </button>
      </div>
      <div class="container" :inert="sending || savingDraft">
        <el-input-tag  @add-tag="addTagChange" tag-type="primary" @input="inputChange" size="default" v-model="form.receiveEmail" >
          <template #prefix>
            <div class="item-title" >{{ $t('recipient') }}</div>
            <el-select
                ref="mySelect"
                class="write-select"
                popper-class="write-select"
                :show-arrow="false"
                :no-match-text="' '"
                :no-data-text="' '"
                @visible-change="selectStatusChange"
                @change="selectChange"
            >
              <el-option
                  v-for="item in selectRecipientList"
                  :key="item"
                  :label="item"
                  :value="item"
                  style="color: #999896;"
              />
            </el-select>
          </template>
          <template #suffix>
            <div style="display: flex;margin-right: 3px;">
              <button type="button" class="add-contact icon-button" :aria-label="$t('selectContacts')" :title="$t('selectContacts')" @click.stop="openContacts">
                <Icon aria-hidden="true" icon="fa7-solid:user-plus" width="20" height="20"/>
              </button>
            </div>
          </template>
        </el-input-tag>
        <el-input v-model="form.subject" :placeholder="t('subject')" />
        <tinyEditor :def-value="defValue" ref="editor" @change="change" @focus="focusChange" />
        <div class="button-item">
          <button type="button" class="att-add icon-button" :aria-label="$t('attachments')" :title="$t('attachments')" @click="chooseFile">
            <Icon aria-hidden="true" icon="iconamoon:attachment-fill" width="24" height="24"/>
          </button>
          <button type="button" class="att-clear icon-button" :aria-label="$t('clear')" :title="$t('clear')" @click="clearContent">
            <Icon aria-hidden="true" icon="icon-park-outline:clear-format" width="24" height="24"/>
          </button>
          <div class="att-list">
            <div class="att-item" v-for="(item,index) in form.attachments" :key="index">
              <Icon v-bind="getIconByName(item.filename)"/>
              <span class="att-filename">{{ item.filename }}</span>
              <span class="att-size">{{ formatBytes(item.size) }}</span>
              <button type="button" class="remove-attachment" :aria-label="$t('delete') + ': ' + item.filename" :title="$t('delete')" @click="delAtt(index)">
                <Icon aria-hidden="true" icon="material-symbols-light:close-rounded" width="22" height="22"/>
              </button>
            </div>
          </div>
          <div>
            <el-button type="primary" :loading="sending" @click="sendEmail" v-if="form.sendType === 'reply'">{{ $t('reply') }}</el-button>
            <el-button type="primary" :loading="sending" @click="sendEmail" v-else-if="form.sendType === 'forward'">{{ $t('forward') }}</el-button>
            <el-button type="primary" :loading="sending" @click="sendEmail" v-else>{{ $t('send') }}</el-button>
          </div>
        </div>
      </div>
    </div>
    <el-dialog v-model="showCloseDialog" append-to-body align-center width="min(480px, calc(100vw - 32px))"
      :title="t('ux.draftCloseTitle')" :close-on-click-modal="false" :close-on-press-escape="!savingDraft"
      :show-close="!savingDraft" @open-auto-focus="focusKeepEditing" @opened="focusKeepEditing" @closed="restoreEditorFocus">
      <p>{{ t('ux.draftCloseHint') }}</p>
      <p v-if="draftSaveError" class="draft-save-error" role="alert">{{ t('ux.draftSaveFailed') }}</p>
      <template #footer>
        <div class="draft-close-actions">
          <el-button type="danger" plain :disabled="savingDraft" @click="resolveClose('discard')">{{ t('ux.draftDiscard') }}</el-button>
          <el-button ref="keepEditingButton" :disabled="savingDraft" @click="resolveClose('continue')">{{ t('ux.draftKeepEditing') }}</el-button>
          <el-button type="primary" :loading="savingDraft" @click="resolveClose('save')">{{ t('ux.draftSaveClose') }}</el-button>
        </div>
      </template>
    </el-dialog>
    <el-dialog top="10vh" v-model="showContacts" @closed="clearSelectContact" :title="t('recentContacts')">
      <el-table ref="contactsTabRef" row-key="email" :data="contacts" style="height: 445px">
        <el-table-column type="selection" width="32" />
        <el-table-column property="email" :label="t('emailAccount')" >
          <template #default="props">
            <div class="email-row">{{ props.row.email }}</div>
          </template>
        </el-table-column>
        <el-table-column width="55" label="" >
          <template #default>
            <div style="display: flex;">
              <Icon icon="mage:user" style="color: var(--el-text-color-primary)" width="22" height="22" color="#606266" />
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="contacts-bottom">
        <el-button type="default" @click="deleteContact">{{t('clear')}}</el-button>
        <el-button type="primary" @click="chooseContact">{{t('selectContacts')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import tinyEditor from '@/components/tiny-editor/index.vue'
import {h, nextTick, onMounted, onUnmounted, reactive, ref, toRaw, computed} from "vue";
import {Icon} from "@iconify/vue";
import {useUserStore} from "@/store/user.js";
import {emailSend} from "@/request/email.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {base64Size, fileToBase64, formatBytes} from "@/utils/file-utils.js";
import {getIconByName} from "@/utils/icon-utils.js";
import sendPercent from "@/components/send-percent/index.vue"
import {toOssDomain} from "@/utils/convert.js";
import {formatDetailDate} from "@/utils/day.js";
import {useSettingStore} from "@/store/setting.js";
import {userDraftStore} from "@/store/draft.js";
import {useWriterStore} from "@/store/writer.js";
import {waitForDraftDatabase} from "@/db/db.js";
import dayjs from "dayjs";
import {useI18n} from "vue-i18n";
import {ElMessageBox} from "element-plus";
import {getSendLimitViolation, SEND_LIMITS} from "@/layout/write/send-limits.js";
import {saveDraft} from "@/db/draft-repository.js";
import {registerSessionResetter, getSessionGeneration} from '@/session/auth-session.js'
import {hasDraftContent, settleDraftClose} from '@/layout/write/close-state.js'
import {stageProgrammaticWriterContent} from '@/layout/write/content-state.js'

defineExpose({
  open,
  openReply,
  openForward,
  openDraft
})

const {t} = useI18n()
const writerStore = useWriterStore();
const draftStore = userDraftStore()
const settingStore = useSettingStore()
const emailStore = useEmailStore();
const accountStore = useAccountStore()
const editor = ref({})
const userStore = useUserStore();
const show = ref(false);
const percent = ref(0)
let percentMessage = null
const sending = ref(false)
const showCloseDialog = ref(false)
const savingDraft = ref(false)
const draftSaveError = ref(false)
const keepEditingButton = ref(null)
let writerEpoch = 0
const defValue = ref('')
const contactsTabRef = ref({})
const showContacts = ref(false)
const mySelect = ref()
let selectStatus = false
const backReply = reactive({
  receiveEmail: [],
  subject: '',
  content: '',
  sendType: ''
})
const form = reactive({
  sendEmail: '',
  receiveEmail: [],
  accountId: -1,
  name: '',
  subject: '',
  content: '',
  sendType: '',
  text: '',
  emailId: 0,
  attachments: [],
  draftId: null,
})

function flushEditorContent() {
  return editor.value?.flushContentSync?.({force: true}) || null
}

const unregisterSessionResetter = registerSessionResetter(() => {
  editor.value?.cancelContentSync?.()
  show.value = false
  sending.value = false
  resetForm()
})

const selectRecipientList = ref([])

const contacts = computed(() => writerStore.sendRecipientRecord.map(item => ({email: item})))

function openContacts() {
  showContacts.value = true
  nextTick(() => {
    form.receiveEmail.forEach(item => {
      if (writerStore.sendRecipientRecord.includes(item)) {
        contactsTabRef.value.toggleRowSelection({email: item});
      }
    })
  })
}

function deleteContact() {
  ElMessageBox.confirm(t('confirmDeletionOfContacts'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
    form.receiveEmail = form.receiveEmail.filter(item => !contactList.includes(item));
    writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(item => !contactList.includes(item));
  })
}

function chooseContact() {

  const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
  const customRecipients = form.receiveEmail.filter(
      item => !writerStore.sendRecipientRecord.includes(item)
  );
  const nextRecipients = [...new Set([...customRecipients, ...contactList])];
  if (nextRecipients.length > SEND_LIMITS.maxRecipients) {
    showSendLimitViolation({type: 'recipients'});
  }
  form.receiveEmail = nextRecipients.slice(0, SEND_LIMITS.maxRecipients);

  showContacts.value = false
}

function clearSelectContact() {
  contactsTabRef.value.clearSelection();
}

function selectChange(value) {
  if (!value || form.receiveEmail.includes(value)) return
  if (form.receiveEmail.length >= SEND_LIMITS.maxRecipients) {
    showSendLimitViolation({type: 'recipients'})
    return
  }
  form.receiveEmail.push(value)
}

function selectStatusChange(status) {
  selectStatus = status
}

const openSelect = () => {
  mySelect.value.toggleMenu()
}

function inputChange(value) {

  selectRecipientList.value = writerStore.sendRecipientRecord.filter(item => value && !form.receiveEmail.includes(item) && item.startsWith(value)).slice(0, 10);

  if (!selectStatus && selectRecipientList.value.length > 0) {
    openSelect()
  }

  if (selectStatus && selectRecipientList.value.length === 0) {
    openSelect()
  }

}

function addTagChange(val) {

  const emails = Array.from(new Set(
      val.split(/[,，]/).map(item => item.trim()).filter(item => item)
  ));

  form.receiveEmail.splice(form.receiveEmail.length - 1, 1)

  let has = false
  for (const email of emails) {
    if (isEmail(email) && !form.receiveEmail.includes(email)) {
      if (form.receiveEmail.length >= SEND_LIMITS.maxRecipients) {
        showSendLimitViolation({type: 'recipients'})
        break
      }
      form.receiveEmail.push(email)
      has = true
    }
  }
  if (selectStatus && has) openSelect()
}

function clearContent() {
  ElMessageBox.confirm(t('clearContentConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    resetForm()
  })

}

function delAtt(index) {
  form.attachments.splice(index, 1);
}

//附件大小限制：base64 内联在 JSON 里发送，过大会拖垮内存和请求
const MIB = 1024 * 1024
const MAX_ATT_SIZE_MB = SEND_LIMITS.maxAttachmentBytes / MIB
const MAX_ATT_TOTAL_SIZE_MB = SEND_LIMITS.maxAttachmentsBytes / MIB

function currentAttachmentSizes(extraSize) {
  const sizes = form.attachments.map(item => {
    if (Number.isFinite(Number(item.size)) && Number(item.size) >= 0) {
      return Number(item.size)
    }
    const content = typeof item.content === 'string' ? item.content.split(',').pop() : ''
    return content ? base64Size(content) : 0
  })
  if (extraSize !== undefined) sizes.push(extraSize)
  return sizes
}

function showSendLimitViolation(violation, filename = '') {
  let message = ''
  switch (violation?.type) {
    case 'recipients':
      message = t('recipientLimitMsg', {count: SEND_LIMITS.maxRecipients})
      break
    case 'attachment-count':
      message = t('attCountLimitMsg', {count: SEND_LIMITS.maxAttachments})
      break
    case 'attachment-size':
      message = t('attTooLargeMsg', {name: filename || t('attachments'), size: MAX_ATT_SIZE_MB})
      break
    case 'attachment-total':
      message = t('attTotalTooLargeMsg', {size: MAX_ATT_TOTAL_SIZE_MB})
      break
    case 'content':
      message = t('contentTooLargeMsg', {size: SEND_LIMITS.maxContentBytes / MIB})
      break
    default:
      return
  }
  ElMessage({message, type: 'error', plain: true})
}

function chooseFile() {
  const doc = document.createElement("input")
  doc.setAttribute("type", "file")
  doc.multiple = true;
  const selectionEpoch = writerEpoch
  const selectionSession = getSessionGeneration()
  doc.onchange = async (e) => {

    const fileList = e.target.files;

    for (const file of fileList) {

      const size = file.size
      const filename = file.name
      const contentType = file.type

      const violation = getSendLimitViolation({attachmentSizes: currentAttachmentSizes(size)})
      if (violation) {
        showSendLimitViolation(violation, filename)
        if (violation.type === 'attachment-size') continue
        break
      }

      const content = await fileToBase64(file)
      if (selectionEpoch !== writerEpoch || selectionSession !== getSessionGeneration()) return
      form.attachments.push({content, filename, size, contentType})

    }

  }
  doc.click()
}

async function sendEmail() {

  flushEditorContent()

  if (form.receiveEmail.length === 0) {
    ElMessage({
      message: t('emptyRecipientMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.subject) {
    ElMessage({
      message: t('emptySubjectMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.content) {
    form.content = editor.value?.getContent?.() || '';
  }

  if (!form.content) {
    ElMessage({
      message: t('emptyContentMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  const limitViolation = getSendLimitViolation({
    recipientCount: form.receiveEmail.length,
    attachmentSizes: currentAttachmentSizes(),
    content: form.content,
    text: form.text
  })
  if (limitViolation) {
    showSendLimitViolation(limitViolation)
    return
  }

  if (form.manyType === 'divide' && form.attachments.length > 0) {
    ElMessage({
      message: t('noSeparateSendMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (sending.value) {
    ElMessage({
      message: t('sendingErrorMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  percentMessage = ElMessage({
    message: () => h(sendPercent, {value: percent.value, desc: t('sending')}),
    dangerouslyUseHTMLString: true,
    plain: true,
    duration: 0,
    customClass: 'message-bottom'
  })

  const sendSession = getSessionGeneration()
  const sendEpoch = writerEpoch
  const isCurrentSend = () => sendSession === getSessionGeneration() && sendEpoch === writerEpoch
  const currentProgress = percentMessage
  sending.value = true

  // Keep the editor visible but inert until the request resolves; no fake completion.

  emailSend(form, (e) => {
    if (isCurrentSend() && e.total > 0) percent.value = Math.round((e.loaded * 98) / e.total)
  }).then(emailList => {
    if (!isCurrentSend()) return
    const email = emailList[0]
    emailList.forEach(item => {
      emailStore.sendScroll?.addItem(item)
    })

    ElNotification({
      title: t('sendSuccessMsg'),
      type: "success",
      message: h('span', {style: 'color: teal'}, email.subject),
      position: 'bottom-right'
    })

    userStore.refreshUserInfo();

    addRecipientRecord();

    if (form.draftId) {
      form.subject = ''
      form.content = ''
      form.receiveEmail = []
      draftStore.setDraft = {...toRaw(form)}
    }

    show.value = false
    resetForm();
  }).catch((e) => {
    if (!isCurrentSend()) return
    ElNotification({
      title: t('sendFailMsg'),
      type: e.code === 403 ? 'warning' : 'error',
      message: h('span', {style: 'color: teal'}, e.message),
      position: 'bottom-right'
    })
    show.value = true
    addRecipientRecord();
  }).finally(() => {
    currentProgress?.close()
    if (sendSession === getSessionGeneration()) {
      percent.value = 0
      sending.value = false
    }
  })
}

function addRecipientRecord() {
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(
      email => !form.receiveEmail.includes(email)
  );

  writerStore.sendRecipientRecord.unshift(...form.receiveEmail);
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.slice(0, 500);
}

function resetForm() {
  writerEpoch++
  showCloseDialog.value = false
  savingDraft.value = false
  draftSaveError.value = false
  editor.value?.cancelContentSync?.()
  form.receiveEmail = []
  form.subject = ''
  form.content = ''
  form.text = ''
  form.manyType = null
  form.attachments = []
  form.sendType = ''
  form.emailId = 0
  form.draftId = null
  backReply.content = ''
  backReply.subject = ''
  backReply.receiveEmail = []
  backReply.sendType = ''
  editor.value?.clearEditor?.()
}

function change(content, text) {
  form.content = content;
  form.text = text
}

function focusChange() {
  if (selectStatus) openSelect()
}

function openForward(email) {
  if (sending.value || savingDraft.value) return
  resetForm();

  email.subject = email.subject || ''

  form.subject = email.subject
  form.sendType = 'forward'

  defValue.value = ''

  setTimeout(() => {
    stageProgrammaticWriterContent({form, defaultValue: defValue}, {
      content: `
        ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
      `,
      text: email.text || ''
    })
    open()

    nextTick(() => {
      backReply.content = editor.value?.getContent?.() || ''
      backReply.subject = form.subject
      backReply.receiveEmail = form.receiveEmail
      backReply.sendType = form.sendType
    })

  });
}

function openReply(email) {
  if (sending.value || savingDraft.value) return

  resetForm();

  email.subject = email.subject || ''

  form.receiveEmail.push(email.sendEmail)
  form.subject = (
      email.subject.startsWith('Re:') ||
      email.subject.startsWith('Re：') ||
      email.subject.startsWith('回复：') ||
      email.subject.startsWith('回复:') ||
      email.subject.startsWith('回覆：') ||
      email.subject.startsWith('回覆:')) ? email.subject : 'Re: ' + email.subject
  form.sendType = 'reply'
  form.emailId = email.emailId

  defValue.value = ''

  setTimeout(() => {
    stageProgrammaticWriterContent({form, defaultValue: defValue}, {
      content: `
      <div></div>
      <div>
      <br>
          ${formatDetailDate(email.createTime)} ${email.name} &lt${email.sendEmail}&gt ${t('wrote')}:
      </div>
      <blockquote class="mceNonEditable" style="margin: 0 0 0 0.8ex;border-left: 1px solid rgb(204,204,204);padding-left: 1ex;">
        <articl>
            ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
        </article>
      </blockquote>`,
      text: email.text || ''
    })
    open()

    nextTick(() => {
      backReply.content = editor.value?.getContent?.() || ''
      backReply.subject = form.subject
      backReply.receiveEmail = form.receiveEmail
      backReply.sendType = form.sendType
    })
  })

}

function formatImage(content) {
  content = content || '';
  const domain = settingStore.settings.r2Domain;
  return content.replace(/{{domain}}/g, toOssDomain(domain) + '/');
}

function open() {
  if (sending.value || savingDraft.value) return
  if (!accountStore.currentAccount.email) {
    form.sendEmail = userStore.user.email;
    form.accountId = userStore.user.account.accountId;
    form.name = userStore.user.name;
  } else {
    form.sendEmail = accountStore.currentAccount.email;
    form.accountId = accountStore.currentAccount.accountId;
    form.name = accountStore.currentAccount.name;
  }
  show.value = true;
  editor.value?.focus?.()
}

function openDraft(draft) {
  if (sending.value || savingDraft.value) return
  editor.value?.cancelContentSync?.()
  Object.assign(form, {...draft})
  defValue.value = ''
  setTimeout(() => defValue.value = form.content)
  show.value = true;
  editor.value?.focus?.()
}

const handleKeyDown = (event) => {
  if (event.key === 'Escape' && show.value && !showCloseDialog.value && !showContacts.value
      && !event.defaultPrevented && !document.querySelector('.tox-dialog')) {
    close()
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  editor.value?.cancelContentSync?.()
  unregisterSessionResetter()
});

function close() {
  if (!show.value || sending.value || savingDraft.value || showCloseDialog.value) return
  flushEditorContent()
  if (selectStatus) openSelect()
  if (!hasDraftContent(form) && form.draftId == null) {
    show.value = false
    resetForm()
    return
  }
  draftSaveError.value = false
  showCloseDialog.value = true
}

function focusKeepEditing() {
  nextTick(() => keepEditingButton.value?.$el?.focus())
}

function restoreEditorFocus() {
  if (show.value) editor.value?.focus?.()
}

async function resolveClose(action) {
  if (savingDraft.value) return
  if (action === 'continue') {
    showCloseDialog.value = false
    return
  }
  const generation = getSessionGeneration()
  const epoch = writerEpoch
  const isCurrent = () => generation === getSessionGeneration() && epoch === writerEpoch
  savingDraft.value = action === 'save'
  draftSaveError.value = false
  try {
    await settleDraftClose(action, {
      isCurrent,
      discard: () => { show.value = false; resetForm() },
      save: async () => {
        flushEditorContent()
        const formData = {
          ...toRaw(form),
          receiveEmail: [...form.receiveEmail],
          attachments: form.attachments.map(item => ({...toRaw(item)})),
          createTime: dayjs().utc().format('YYYY-MM-DD HH:mm:ss')
        }
        const database = await waitForDraftDatabase()
        if (!isCurrent()) return
        if (!database) throw new Error('Draft database is unavailable')
        await saveDraft(database, formData)
        if (isCurrent()) {
          draftStore.refreshList++
          ElMessage({message: t('ux.draftSavedLocal'), type: 'success'})
        }
      }
    })
  } catch {
    if (isCurrent()) draftSaveError.value = true
  } finally {
    if (isCurrent()) savingDraft.value = false
  }
}

</script>
<style>
.draft-save-error { color: var(--el-color-danger); margin-top: 12px; }
.draft-close-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.draft-close-actions .el-button { margin: 0; min-height: 40px; }
@media (max-width: 767px) {
  .draft-close-actions { flex-direction: column-reverse; }
  .draft-close-actions .el-button { width: 100%; min-height: 44px; }
}
.write-select .el-select-dropdown__list {
  padding: 4px 4px !important;
}
.write-select .el-select-dropdown__item {
  padding: 0 10px 0 10px;
}

.write-select .el-select-dropdown {
  min-width: 0 !important;
}
</style>
<style scoped lang="scss">
.send {
  z-index: 110;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(13 25 46 / 35%);

  .write-box {
    background: var(--el-bg-color);
    width: min(1120px, calc(100% - 80px));
    box-shadow: 0 24px 80px rgb(9 20 39 / 24%);
    border: 1px solid var(--el-border-color-light);
    padding: 24px;
    border-radius: 20px;
    display: grid;
    grid-template-rows: auto 1fr;
    overflow: hidden;
    @media (max-width: 1024px) {
      width: 100%;
      height: 100dvh;
      border-radius: 0;
      border: 0;
      padding: 16px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }

    @media (min-width: 1025px) {
      height: min(800px, calc(100vh - 60px));
    }

    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;

      .title-left {
        min-width: 0;
        align-items: center;
        display: grid;
        grid-template-columns: auto auto auto 1fr;
      }

      .title-text { color: var(--el-color-primary); }

      .sender {
        margin-left: 8px;
      }

      .sender-name {
        margin-left: 8px;
        font-weight: bold;
      }

      .send-email {
        color: var(--secondary-text-color);
        margin-left: 5px;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }


      div {
        display: flex;
        align-items: center;
      }
    }

    .container {
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 15px;

      .item-title { color: var(--secondary-text-color); }

      .button-item {
        display: grid;
        grid-template-columns: auto auto 1fr auto;

        .att-add {
          color: var(--regular-text-color);
        }

        .att-clear {
          color: var(--regular-text-color);
          margin-left: 10px;
        }

        .att-list {
          display: grid;
          gap: 5px;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          padding-left: 10px;
          padding-right: 10px;
          max-height: 110px;
          overflow-y: auto;
          @media (max-width: 450px) {
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          }

          .att-item {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            gap: 5px;
            height: 32px;
            font-size: 14px;
            padding: 4px 5px;
            background: var(--light-fill);
            border-radius: 4px;
            .att-filename {
              white-space: nowrap;
              text-overflow: ellipsis;
              overflow: hidden;
            }
          }
        }
      }
    }
  }

}

.email-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.el-dialog) {
  width: 420px !important;
  @media (max-width: 460px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.contacts-bottom {
  display: flex;
  justify-content: end;
  margin-top: 10px;
}

.add-contact {
  color: var(--regular-text-color)
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: inherit;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast), transform var(--transition-fast);

  &:hover { color: var(--el-color-primary); background: var(--light-fill); }
  &:active { transform: translateY(1px); }
}

.remove-attachment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--regular-text-color);
  border-radius: var(--radius-sm);
  cursor: pointer;

  &:hover { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
}

.write-select {
  position: absolute;
  width: 300px;
  left: 60px;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
}

:deep(.el-input-tag__suffix) {
  padding-right: 4px;
}

.icon {
  cursor: pointer;
}
.close-writer { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--radius-md); color: var(--regular-text-color); cursor: pointer; }
.close-writer:hover { background: var(--light-fill); color: var(--el-color-primary); }
</style>
