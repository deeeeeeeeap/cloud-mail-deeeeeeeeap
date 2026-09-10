<template>
  <section class="mail-reader" :aria-busy="loadingInline">
    <div class="reader-controls" role="group" :aria-label="labels.controls">
      <span class="reader-notice">{{ allowRemote ? labels.remoteLoaded : labels.private }}</span>
      <button v-if="prepared.remoteCount" type="button" @click="allowRemote = !allowRemote">
        {{ allowRemote ? labels.hideRemote : labels.loadRemote }}
      </button>
    </div>
    <p v-if="inlineFailed" class="reader-warning" role="status">{{ labels.inlineFailed }}</p>
    <!-- Deliberately no allow-scripts, allow-forms, allow-popups or top navigation.
         allow-same-origin only lets trusted PARENT code measure and handle links. -->
    <iframe ref="frame" class="mail-frame" :title="labels.body" sandbox="allow-same-origin"
      referrerpolicy="no-referrer" :srcdoc="srcdoc" :style="{ height: frameHeight + 'px' }" @load="onFrameLoad" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { inlineAttachmentUrl, mailDocument, prepareMailBody } from '@/utils/mail-reader.js';
import { safeLink } from '@/utils/html-sanitize.js';

const props = defineProps({
  html: { type: String, required: true },
  emailId: { type: [String, Number], default: null },
  scope: { type: String, default: 'user' }
});
const { locale } = useI18n();
const labels = computed(() => String(locale.value).startsWith('zh') ? {
  controls: '邮件阅读选项', body: '邮件正文', private: '远程图片默认隐藏，保护阅读隐私',
  remoteLoaded: '已允许本封邮件加载远程图片', loadRemote: '加载远程图片', hideRemote: '隐藏远程图片',
  inlineFailed: '部分内嵌图片未能加载，请重新打开邮件后重试。'
} : {
  controls: 'Mail reading options', body: 'Email body', private: 'Remote images are hidden for your privacy',
  remoteLoaded: 'Remote images are allowed for this message', loadRemote: 'Load remote images', hideRemote: 'Hide remote images',
  inlineFailed: 'Some inline images could not be loaded. Reopen this message to retry.'
});
const frame = ref(null);
const frameHeight = ref(160);
const allowRemote = ref(false);
const inlineUrls = ref(new Map());
const inlineFailed = ref(false);
const loadingInline = ref(false);
const prepared = computed(() => prepareMailBody(props.html, { remoteImages: allowRemote.value, inlineUrls: inlineUrls.value }));
const srcdoc = computed(() => mailDocument(prepared.value.html, allowRemote.value));
let epoch = 0;
let controller;
let observer;
let animationFrame = 0;
let detachFrameEvents = () => {};

function releaseImages() {
  for (const url of inlineUrls.value.values()) URL.revokeObjectURL(url);
  inlineUrls.value = new Map();
}

async function boundedImage(response) {
  const maxBytes = 16 * 1024 * 1024;
  if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Inline image unavailable');
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new Error('Inline image display limit exceeded');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Inline image display limit exceeded'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('content-type') });
}

async function loadInlineImages() {
  const currentEpoch = ++epoch;
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  releaseImages();
  allowRemote.value = false;
  frameHeight.value = 160;
  inlineFailed.value = false;
  const keys = prepareMailBody(props.html).inlineKeys;
  loadingInline.value = keys.length > 0;
  if (!keys.length) return;
  if (!props.emailId) { inlineFailed.value = true; loadingInline.value = false; return; }
  const pending = keys.slice(0, 64);
  inlineFailed.value = pending.length !== keys.length;
  let totalBytes = 0;
  const token = localStorage.getItem('token') || '';
  const worker = async () => {
    while (pending.length && currentEpoch === epoch) {
      const key = pending.shift();
      try {
        const url = inlineAttachmentUrl(import.meta.env.VITE_BASE_URL || '/api', { emailId: props.emailId, key, scope: props.scope });
        const response = await fetch(url, {
          headers: { Authorization: token }, signal: currentController.signal,
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
        });
        const blob = await boundedImage(response);
        if (currentEpoch !== epoch) return;
        totalBytes += blob.size;
        if (totalBytes > 32 * 1024 * 1024) throw new Error('Inline image display budget exceeded');
        inlineUrls.value = new Map(inlineUrls.value).set(key, URL.createObjectURL(blob));
      } catch (error) {
        if (currentEpoch === epoch && error.name !== 'AbortError') inlineFailed.value = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (currentEpoch === epoch) loadingInline.value = false;
}

function resizeFrame() {
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(() => {
    const body = frame.value?.contentDocument?.body;
    if (body) frameHeight.value = Math.min(20000, Math.max(80, Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)) + 2));
  });
}

function onFrameLoad() {
  observer?.disconnect();
  detachFrameEvents();
  const doc = frame.value?.contentDocument;
  if (!doc?.body) return;
  const onClick = event => {
    const link = event.target?.closest?.('a');
    if (!link) return;
    event.preventDefault();
    const href = safeLink(link.getAttribute('href'));
    if (href && event.isTrusted) window.open(href, '_blank', 'noopener,noreferrer');
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  doc.addEventListener('load', resizeFrame, true);
  detachFrameEvents = () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
    doc.removeEventListener('load', resizeFrame, true);
  };
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resizeFrame);
    observer.observe(doc.body);
  }
  resizeFrame();
}

watch(() => [props.html, props.emailId, props.scope], loadInlineImages, { immediate: true });
watch(srcdoc, () => { frameHeight.value = 160; });
onBeforeUnmount(() => {
  epoch++;
  controller?.abort();
  observer?.disconnect();
  detachFrameEvents();
  cancelAnimationFrame(animationFrame);
  releaseImages();
});
</script>

<style scoped>
.mail-reader { width: 100%; min-width: 0; contain: layout paint style; }
.reader-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.reader-controls button { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 6px 10px; background: var(--el-bg-color); color: var(--el-color-primary); cursor: pointer; font: inherit; }
.reader-controls button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.reader-warning { margin: 4px; font-size: 12px; color: var(--el-color-warning-dark-2); }
.mail-frame { display: block; width: 100%; max-width: 100%; min-width: 0; border: 0; background: #fff; border-radius: 6px; }
</style>
