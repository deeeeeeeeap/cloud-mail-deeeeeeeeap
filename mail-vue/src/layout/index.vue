<template>
  <el-container class="layout">
    <el-aside
        id="app-navigation"
        class="aside"
        @keydown.esc="closeNavigation"
        :inert="!uiStore.asideShow"
        :class="uiStore.asideShow ? 'aside-show' : 'el-aside-hide'">
      <Aside />
    </el-aside>
    <div
        :class="(uiStore.asideShow && isMobile)? 'overlay-show':'overlay-hide'"
        @click="closeNavigation"
    ></div>
    <el-container class="main-container" :inert="isMobile && uiStore.asideShow">
      <el-main>
        <el-header>
            <Header />
        </el-header>
        <Main />
      </el-main>
    </el-container>
  </el-container>
  <component :is="WriterComponent" v-if="writerMounted && WriterComponent" ref="writerRef" />
</template>

<script setup>
import Aside from '@/layout/aside/index.vue'
import Header from '@/layout/header/index.vue'
import Main from '@/layout/main/index.vue'
import { ref, onMounted, onBeforeUnmount, nextTick, shallowRef } from 'vue'
import {useUiStore} from "@/store/ui.js";
import {createWriterIntentLoader} from '@/layout/writer-intent-loader.js'
import {getSessionGeneration} from '@/session/auth-session.js'
import {createBreakpointTransition} from '@/layout/responsive-navigation.js'

const uiStore = useUiStore();
const WriterComponent = shallowRef(null)
const writerMounted = ref(false)
const writerRef = ref(null)
const isMobile = ref(window.innerWidth < 1025)
function closeNavigation() {
  uiStore.asideShow = false
  nextTick(() => document.querySelector('.menu-toggle')?.focus())
}
const writerIntentLoader = createWriterIntentLoader({
  loadShell: () => import('@/layout/write/index.vue').then(module => {
    WriterComponent.value = module.default
    return module.default
  }),
  loadEditor: () => import('@/components/tiny-editor/loader.js')
    .then(module => module.loadTinyMCE())
})

const writerApi = {
  preload: () => writerIntentLoader.preload(),
  open: (...args) => callWriter('open', ...args),
  openReply: (...args) => callWriter('openReply', ...args),
  openForward: (...args) => callWriter('openForward', ...args),
  openDraft: (...args) => callWriter('openDraft', ...args)
}

const applyLayoutMode = createBreakpointTransition(mobile => {
  isMobile.value = mobile
  uiStore.asideShow = !mobile
})
const handleResize = () => applyLayoutMode(window.innerWidth)

async function loadWriter() {
  if (!WriterComponent.value) {
    await writerIntentLoader.loadShell()
  }

  writerMounted.value = true
  await nextTick()
  return writerRef.value
}

async function callWriter(method, ...args) {
  const generation = getSessionGeneration()
  writerIntentLoader.loadEditor().catch(() => {})
  const writer = await loadWriter()
  if (generation !== getSessionGeneration()) return null
  writer?.[method]?.(...args)
}

onMounted(() => {
  uiStore.writerRef = writerApi

  window.addEventListener('resize', handleResize)
  handleResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
})
</script>

<style lang="scss" scoped>
.el-aside-hide {
  position: fixed;
  left: 0;
  height: 100%;
  z-index: 100;
  transform: translateX(-100%);
  transition: transform var(--transition-base);
}

.aside-show {
  transform: translateX(0);
  transition: transform var(--transition-base);
  z-index: 101;
  @media (max-width: 1024px) {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 101;
    height: 100%;
    background: var(--aside-background);
  }
}

.el-aside {
  width: auto;
  transition: transform var(--transition-base);
}

.layout {
  padding: 10px 10px 10px 0;
  background: var(--aside-background);
  height: 100%;
  position: fixed;
  width: 100%;
  top: 0;
  left: 0;
  overflow: hidden;
  @media (max-width: 1024px) { padding: 0; }
}

.main-container {
  min-width: 0;
  height: 100%;
  background: var(--el-bg-color);
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  border-radius: 18px;
  box-shadow: 0 8px 32px rgb(9 20 39 / 10%);
  @media (max-width: 1024px) { border-radius: 0; box-shadow: none; }
}

.el-main {
  padding: 0;
  min-width: 0;
  overflow: hidden;
}

.el-header {
  --el-header-height: var(--header-height);
  background: var(--el-bg-color);
  border-bottom: solid 1px var(--el-border-color-light);
  padding: 0 0 0 0;
}

.overlay-show {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgb(13 25 46 / 42%);
  z-index: 99;
  transition: opacity var(--transition-base);
}

.overlay-hide {
  display: flex;
  pointer-events: none;
  opacity: 0;
}
</style>
