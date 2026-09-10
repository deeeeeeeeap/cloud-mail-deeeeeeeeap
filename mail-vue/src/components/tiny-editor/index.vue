<template>
  <div class="editor-box" :class="showLoading ? 'editor-box-loading' : ''">
    <loading class="loading" v-if="showLoading"/>
    <div v-if="loadFailed" class="editor-error" role="alert">
      <p>{{ t('ux.editorFailed') }}</p>
      <el-button @click="initTinyMCE">{{ t('ux.editorRetry') }}</el-button>
    </div>
    <textarea v-if="!showLoading && !loadFailed" style="outline: none" :id="editorId" ref="editorRef"></textarea>
  </div>
</template>

<script setup>
import {ref, onMounted, onBeforeUnmount, watch, nextTick, shallowRef, defineEmits, computed} from 'vue';
import loading from "@/components/loading/index.vue";
import {useI18n} from 'vue-i18n'
import {useUiStore} from '@/store/ui.js'
import {useSettingStore} from '@/store/setting.js'
import {
  assetUrl,
  createRetryableInitTask,
  loadTinyMCE
} from '@/components/tiny-editor/loader.js'
import {createEditorContentSync} from '@/components/tiny-editor/content-sync.js'
import {getSessionGeneration} from '@/session/auth-session.js'

defineExpose({
  clearEditor,
  focus,
  getContent,
  getContentSnapshot,
  flushContentSync,
  cancelContentSync,
  ensureReady: initTinyMCE
})

const props = defineProps({
  defValue: {
    type: String,
    default: ''
  },
  editorId: {
    type: String,
    default: () => `editor-${Date.now()}`
  }
});


const {locale, t} = useI18n()
const emit = defineEmits(['change','focus']);
const editor = shallowRef(null);
const isInitialized = ref(false);
const editorRef = ref(null);
const showLoading = ref(false);
const loadFailed = ref(false);
const uiStore = useUiStore();
const settingStore = useSettingStore();
let initToken = 0;
let pendingFocus = false;
let preservedContent = null;

const contentSync = createEditorContentSync({
  getGeneration: getSessionGeneration,
  read: getContentSnapshot,
  publish: ({content, text}) => emit('change', content, text),
  onError: error => console.warn('TinyMCE 内容同步失败', error)
})
const initTask = createRetryableInitTask(initializeTinyMCE)

onMounted(() => {
  initTinyMCE();
});

onBeforeUnmount(() => {
  contentSync.cancel();
  initTask.cancel();
  destroyEditor();
});

watch(() => props.defValue, (newValue) => {
  contentSync.cancel();
  preservedContent = null;
  if (editor.value && editor.value.getContent() !== newValue) {
    editor.value.setContent(newValue);
  }
});

watch(() => [uiStore.dark, settingStore.lang], () => {
  flushContentSync();
  preservedContent = editor.value?.getContent() ?? preservedContent;
  destroyEditor();
  initTask.restart();
});

// 对应 public/tinymce/langs 下的语言包文件名，en 为 TinyMCE 内置
const TINYMCE_LANGS = {
  zh: 'zh_CN',
  'zh-tw': 'zh_TW',
  ja: 'ja',
}

const language = computed(() => TINYMCE_LANGS[locale.value] || 'en')

function clearEditor() {
  contentSync.cancel();
  preservedContent = null;
  if (editor.value) {
    editor.value.setContent('');
  }
}

function initTinyMCE() {
  if (editor.value && isInitialized.value) return Promise.resolve(editor.value);
  return initTask.start();
}

async function initializeTinyMCE() {
  const token = ++initToken;
  loadFailed.value = false;
  showLoading.value = !window.tinymce;
  try {
    await loadTinyMCE();
    if (token !== initToken) return;
    showLoading.value = false;
    await nextTick();
    if (token !== initToken) return;
    await initEditor();
  } catch (error) {
    if (token !== initToken) return;
    // Preserve staged/edited content for a retry; never replace it with an empty editor.
    if (isInitialized.value) preservedContent = editor.value?.getContent?.() ?? preservedContent;
    destroyEditor();
    showLoading.value = false;
    loadFailed.value = true;
    console.warn('TinyMCE initialization failed', error);
  }
}

function initEditor() {
  if (!window.tinymce || !editorRef.value || editor.value) {
    return;
  }

  return window.tinymce.init({
    selector: `#${props.editorId}`,
    statusbar: false,
    height: "100%",
    //relative_urls: false,  //阻止 img标签域名和网站域名相同 自动把链接转换相对路径
    //remove_script_host: false, // 阻止删除 URL 中的域名
    forced_root_block: 'div',
    skin: `${uiStore.dark ? 'oxide-dark' : 'oxide'}`,
    content_css: `${assetUrl('tinymce/css/index.css')},${uiStore.dark ? 'dark' : 'default'}`,
    content_style: `:root {
         --scrollbar-track-color: ${uiStore.dark ? '#141414' : '#FFFFFF'};
         --scrollbar-thumb-color: ${uiStore.dark ? '#8D9095' : '#A8ABB2'};
    }`,
    plugins: 'link image advlist lists  emoticons fullscreen  table preview code',
    toolbar: 'bold emoticons forecolor backcolor italic fontsize | alignleft aligncenter alignright alignjustify | outdent indent |  bullist numlist | link image  | table code preview fullscreen',
    toolbar_mode: 'scrolling',
    font_size_formats: '8px 10px 12px 14px 16px 18px 24px 36px',
    emoticons_search: false,
    language: language.value,
    language_load: true,
    menubar: false,
    license_key: 'gpl',
    noneditable_class: 'mceNonEditable',
    setup: (ed) => {
      editor.value = ed;
      ed.on('init', () => {
        ed.setContent(preservedContent ?? props.defValue);
        preservedContent = null;
        isInitialized.value = true;
        if (pendingFocus) {
          pendingFocus = false;
          setTimeout(() => {
            if (editor.value === ed && isInitialized.value) ed.focus();
          });
        }
      });
      ed.on('input change', () => {
        contentSync.markDirty();
      });
      ed.on('focus', () => {
        emit('focus', focus);
      })
    },
    branding: false,
    file_picker_types: 'image',
    image_dimensions: false,
    image_description: false,
    link_title: false,
    dialog_type: 'none',
    file_picker_callback: (callback, value, meta) => {
      const input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/*');

      input.addEventListener('change', async (e) => {
        let file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = () => {
          const id = 'blobid' + (new Date()).getTime();
          const blobCache = tinymce.activeEditor.editorUpload.blobCache;
          const base64 = reader.result.split(',')[1];
          const blobInfo = blobCache.create(id, file, base64);
          blobCache.add(blobInfo);

          callback(blobInfo.blobUri(), {title: file.name});
        }
        reader.readAsDataURL(file);
      });

      input.click();
    }
  });
}

function focus() {
  if (!editor.value || !isInitialized.value) {
    pendingFocus = true;
    initTinyMCE();
    return;
  }

  nextTick(() => {
    editor.value?.focus()
  })
}

function getContent() {
  return editor.value?.getContent() || ''
}

function getContentSnapshot() {
  if (!editor.value) return null
  return {
    content: editor.value.getContent() || '',
    text: editor.value.getContent({format: 'text'}) || ''
  }
}

function flushContentSync(options) {
  return contentSync.flush(options)
}

function cancelContentSync() {
  contentSync.cancel()
}


function destroyEditor() {
  initToken++;
  isInitialized.value = false;
  if (editor.value) {
    editor.value.destroy();
    editor.value = null;
  }
}
</script>

<style lang="scss" scoped>
.editor-error { padding: 24px; text-align: center; color: var(--el-text-color-regular); }
.editor-error p { margin-bottom: 12px; }
.editor-box {
  min-height: 0;
  height: 100%;
  width: 100%;
}

.loading {
  margin: auto;
}

.editor-box-loading {
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.tox-tbtn.tox-tbtn--select.tox-tbtn--bespoke) {
  width: 80px !important;
}

:deep(.tox.tox-tinymce.tox-fullscreen) {
  padding-right: 15px;
  padding-left: 15px;
  padding-bottom: 15px;
  background: var(--el-bg-color);
  @media (max-width: 767px) {
    padding-right: 10px;
    padding-left: 10px;
    padding-bottom: 10px;
  }
}

:deep(.tox-tinymce) {
  border: none;
  border-radius: 0;
}

:deep(.tox-toolbar__group) {
  padding-left: 0 !important;
  margin: 0 !important;
}

:deep(.tox-tbtn) {
  margin: 0 !important;
}

:deep(.tox .tox-edit-area::before) {
  display: none;
}

</style>
