<template>
  <div class="editor-box" :class="showLoading ? 'editor-box-loading' : ''">
    <loading class="loading" v-if="showLoading"/>
    <textarea v-else style="outline: none" :id="editorId" ref="editorRef"></textarea>
  </div>
</template>

<script setup>
import {ref, onMounted, onBeforeUnmount, watch, nextTick, shallowRef, defineEmits, computed} from 'vue';
import loading from "@/components/loading/index.vue";
import {useI18n} from 'vue-i18n'
import {useUiStore} from '@/store/ui.js'
import {useSettingStore} from '@/store/setting.js'

defineExpose({
  clearEditor,
  focus,
  getContent
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


const {locale} = useI18n()
const emit = defineEmits(['change','focus']);
const editor = shallowRef(null);
const isInitialized = ref(false);
const editorRef = ref(null);
const showLoading = ref(false);
const uiStore = useUiStore();
const settingStore = useSettingStore();
let initToken = 0;
let pendingFocus = false;

function assetUrl(path) {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;
}

onMounted(() => {
  initTinyMCE();
});

onBeforeUnmount(() => {
  destroyEditor();
});

watch(() => props.defValue, (newValue) => {
  if (editor.value && editor.value.getContent() !== newValue) {
    editor.value.setContent(newValue);
  }
});

watch(() => [uiStore.dark, settingStore.lang], () => {
  destroyEditor();
  initTinyMCE();
});

const language = computed(() => {
  if (locale.value === 'zh') {
    return 'zh_CN'
  }

  return 'en'
})

function clearEditor() {
  if (editor.value) {
    editor.value.setContent('');
  }
}

async function initTinyMCE() {
  const token = ++initToken;
  showLoading.value = !window.tinymce;

  try {
    await loadTinyMCE();
  } catch (e) {
    showLoading.value = false;
    console.warn('TinyMCE 加载失败', e);
    return;
  }

  if (token !== initToken) return;

  showLoading.value = false;
  await nextTick();

  if (token !== initToken) return;
  initEditor();
}

function loadTinyMCE() {
  if (window.tinymce) {
    return Promise.resolve(window.tinymce);
  }

  if (window.__cloudMailTinyMCELoadPromise) {
    return window.__cloudMailTinyMCELoadPromise;
  }

  window.__cloudMailTinyMCELoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = assetUrl('tinymce/tinymce.min.js');
    script.async = true;
    script.onload = () => window.tinymce ? resolve(window.tinymce) : reject(new Error('TinyMCE not available'));
    script.onerror = () => {
      window.__cloudMailTinyMCELoadPromise = null;
      reject(new Error('TinyMCE script failed to load'));
    };
    document.head.appendChild(script);
  });

  return window.__cloudMailTinyMCELoadPromise;
}

function initEditor() {
  if (!window.tinymce || !editorRef.value) {
    return;
  }

  window.tinymce.init({
    selector: `#${props.editorId}`,
    statusbar: false,
    height: "100%",
    auto_focus: true,
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
        ed.setContent(props.defValue);
        isInitialized.value = true;
        if (pendingFocus) {
          pendingFocus = false;
          nextTick(() => ed.focus());
        }
      });
      ed.on('input change', () => {
        const content = ed.getContent();
        const text = ed.getContent({format: 'text'});
        emit('change', content, text);
      });
      ed.on('focus', () => {
        emit('focus', focus);
      })
    },
    autofocus: true,
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
  if (!editor.value) {
    pendingFocus = true;
    return;
  }

  nextTick(() => {
    editor.value?.focus()
  })
}

function getContent() {
  return editor.value?.getContent() || ''
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
.editor-box {
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
