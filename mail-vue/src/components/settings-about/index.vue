<template>
  <div class="settings-about">
    <div class="about-version">
      <span>{{ $t('version') }}</span>
      <el-badge is-dot :hidden="!hasUpdate">
        <a class="version-link" :href="repoUrl + '/releases'" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true"><path d="M6 5v10m0-5h4a4 4 0 0 0 4-4" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="16" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="14" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/></svg>
          <span>{{ version }}</span><span aria-hidden="true">↗</span>
        </a>
      </el-badge>
    </div>
    <div class="resource-links">
      <a class="resource-link resource-link--github" :href="repoUrl" target="_blank" rel="noopener noreferrer">
        <span class="resource-mark" aria-hidden="true"><Icon icon="codicon:github-inverted" width="24" height="24"/></span>
        <span class="resource-copy"><span>{{ $t('community') }}</span><strong>GitHub</strong></span>
        <span class="resource-arrow" aria-hidden="true">↗</span>
      </a>
      <a class="resource-link" :href="docsUrl" target="_blank" rel="noopener noreferrer">
        <span class="resource-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="resource-copy"><span>{{ $t('help') }}</span><strong>{{ $t('document') }}</strong></span>
        <span class="resource-arrow" aria-hidden="true">↗</span>
      </a>
    </div>
  </div>
</template>
<script setup>
import {Icon} from '@iconify/vue'
import {ElBadge} from 'element-plus'
defineProps({
  version: {type: String, required: true},
  repoUrl: {type: String, required: true},
  docsUrl: {type: String, required: true},
  hasUpdate: Boolean
})
</script>
<style scoped>
.settings-about { min-width: 0; container-type: inline-size; }
.about-version { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 18px; margin-bottom: 18px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); }
.version-link { display: inline-flex; align-items: center; gap: 9px; min-height: 36px; padding: 7px 11px; border: 1px solid var(--el-border-color-light); border-radius: 8px; color: var(--el-text-color-regular); background: var(--el-fill-color-extra-light); text-decoration: none; font-size: 12px; }
.version-link:hover { border-color: var(--el-text-color-placeholder); }
.resource-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.resource-link { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 76px; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 11px; color: var(--el-text-color-primary); background: var(--el-bg-color); text-decoration: none; transition: border-color 160ms ease, box-shadow 160ms ease; }
.resource-link--github { color: #fafafa; background: #27272a; border-color: #27272a; }
.resource-mark { position: relative; isolation: isolate; flex: 0 0 28px; width: 28px; height: 32px; display: grid; place-items: center; }
/* Original, restrained layered-icon treatment inspired by the supplied Uiverse reference. */
.resource-mark::before { content: ''; position: absolute; inset: -4px; z-index: -1; border: 1px solid currentColor; border-radius: 8px; opacity: 0; transform: rotate(0); transition: transform 160ms ease, opacity 160ms ease; }
.resource-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.resource-copy > span { font-size: 12px; line-height: 1.4; opacity: .72; }
.resource-copy strong { font-size: 14px; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
.resource-arrow { margin-left: auto; opacity: .65; flex-shrink: 0; }
.version-link:focus-visible, .resource-link:focus-visible { outline: 2px solid var(--el-text-color-primary); outline-offset: 3px; }
@media (hover: hover) {
  .resource-link:hover { border-color: var(--el-text-color-secondary); box-shadow: 0 3px 10px rgb(0 0 0 / 6%); }
  .resource-link:hover .resource-mark::before { opacity: .25; transform: rotate(-9deg); }
  .resource-link:hover .resource-arrow { opacity: 1; }
}
@container (max-width: 350px) { .resource-links { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .resource-links { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .resource-link, .resource-mark::before { transition: none; } .resource-link:hover .resource-mark::before { transform: none; } }
</style>
