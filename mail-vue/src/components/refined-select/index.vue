<template>
  <el-select
    ref="select"
    v-bind="$attrs"
    class="refined-select"
    :class="{'refined-select--compact': compact, 'refined-select--empty': modelValue === '' || modelValue == null}"
    :model-value="modelValue"
    :suffix-icon="SelectorIcon"
    :popper-class="['refined-select-popper', $attrs['popper-class']].filter(Boolean).join(' ')"
    :show-arrow="false"
    :offset="6"
    :popper-options="{modifiers: [{name: 'preventOverflow', options: {padding: 12}}]}"
    :aria-label="ariaLabel"
    @update:model-value="emit('update:modelValue', $event)"
    @keydown.enter.stop
    @keyup.enter.stop
  >
    <slot/>
  </el-select>
</template>

<script setup>
import {h, ref} from 'vue'
import {ElSelect} from 'element-plus'

defineOptions({inheritAttrs: false})
defineProps({
  modelValue: {type: [String, Number], default: ''},
  ariaLabel: {type: String, required: true},
  compact: Boolean
})
const emit = defineEmits(['update:modelValue'])
const select = ref()
// A fixed selector glyph, not a disclosure arrow that flips against the label.
const SelectorIcon = () => h('svg', {
  viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
  'aria-hidden': 'true', focusable: 'false'
}, [h('path', {
  d: 'm5.5 6 2.5-2.5L10.5 6m-5 4L8 12.5l2.5-2.5',
  stroke: 'currentColor', 'stroke-width': 1.4,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round'
})])
defineExpose({focus: () => select.value?.focus(), blur: () => select.value?.blur()})
</script>

<style scoped>
.refined-select { width: var(--refined-select-width, 168px); max-width: 100%; min-width: 0; vertical-align: middle; }
.refined-select :deep(.el-select__wrapper) {
  min-height: 40px; height: 100%; gap: 12px; padding: 9px 12px;
  border-radius: 8px; background: var(--el-bg-color);
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
  transition: box-shadow 150ms ease, background-color 150ms ease;
}
.refined-select :deep(.el-select__wrapper:hover:not(.is-disabled)) { box-shadow: 0 0 0 1px var(--el-text-color-placeholder) inset; }
.refined-select :deep(.el-select__wrapper.is-focused) {
  background: var(--el-fill-color-extra-light);
  box-shadow: 0 0 0 1px var(--el-text-color-secondary) inset, 0 0 0 3px var(--el-fill-color);
}
.refined-select :deep(.el-select__wrapper.is-disabled) { opacity: .6; background: var(--el-fill-color-light); }
.refined-select :deep(.el-select__selection) { min-width: 0; }
.refined-select :deep(.el-select__placeholder) { font-size: 13px; line-height: 20px; color: var(--el-text-color-primary); }
.refined-select--empty :deep(.el-select__placeholder.is-transparent) { color: var(--el-text-color-placeholder); }
.refined-select :deep(.el-select__suffix) { flex-shrink: 0; margin: 0; }
.refined-select :deep(.el-select__caret) { width: 16px; height: 16px; color: var(--el-text-color-secondary); transform: none !important; }
.refined-select--compact { --refined-select-width: 132px; }
.refined-select--compact :deep(.el-select__wrapper) { min-height: 36px; padding: 7px 10px; }
@media (max-width: 767px) {
  .refined-select :deep(.el-select__wrapper) { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .refined-select :deep(.el-select__wrapper) { transition: none; }
}
</style>

<style>
/* Teleported menus need their own namespace; never restyle unrelated selects. */
.refined-select-popper.el-popper {
  max-width: calc(100vw - 24px); padding: 4px; border-radius: 10px;
  border: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay);
  box-shadow: 0 8px 28px rgb(0 0 0 / 10%), 0 2px 6px rgb(0 0 0 / 4%);
}
.refined-select-popper .el-select-dropdown { max-width: calc(100vw - 34px); }
.refined-select-popper .el-select-dropdown__list { padding: 0; }
.refined-select-popper .el-select-dropdown__wrap { max-height: min(280px, 50vh); }
.refined-select-popper .el-select-dropdown__item {
  position: relative; height: 36px; margin: 2px 0; padding: 0 34px 0 10px;
  border-radius: 6px; font-size: 13px; line-height: 36px;
  color: var(--el-text-color-primary); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.refined-select-popper .el-select-dropdown__item.is-hovering,
.refined-select-popper .el-select-dropdown__item.is-selected { background: var(--el-fill-color-light); color: var(--el-text-color-primary); }
.refined-select-popper .el-select-dropdown__item.is-selected { font-weight: 600; }
.refined-select-popper .el-select-dropdown__item.is-selected::after {
  content: ''; position: absolute; right: 13px; top: 12px;
  width: 5px; height: 9px; border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor; transform: rotate(45deg);
}
.refined-select-popper .el-select-dropdown__item.is-disabled { color: var(--el-text-color-placeholder); background: transparent; }
@media (max-width: 767px) {
  .refined-select-popper .el-select-dropdown__item { height: 44px; line-height: 44px; }
  .refined-select-popper .el-select-dropdown__item.is-selected::after { top: 16px; }
}
</style>
