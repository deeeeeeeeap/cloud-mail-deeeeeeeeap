<template>
  <!-- Keep Element Plus' combobox, focus management and keyboard interaction.
       This is a visible select, not a transparent control under a fake trigger. -->
  <ElSelect v-bind="$attrs" class="ui-select" :model-value="modelValue" :disabled="disabled"
    :placeholder="placeholder" :suffix-icon="SelectorIcon" :show-arrow="false" :offset="6"
    popper-class="ui-select-menu" :fit-input-width="true" :title="selectedLabel"
    @update:model-value="$emit('update:modelValue', $event)" @change="$emit('change', $event)"
    @keydown.enter.stop @keyup.enter.stop>
    <ElOption v-for="option in normalizedOptions" :key="option.value" :value="option.value"
      :label="option.label" :disabled="option.disabled" :title="option.label">
      <span class="ui-select-option-text">{{ option.label }}</span>
      <svg v-if="option.value === modelValue" class="ui-select-check" width="16" height="16"
        viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
        <path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </ElOption>
  </ElSelect>
</template>

<script setup>
import {computed} from 'vue'
import {ElSelect, ElOption} from 'element-plus'
import SelectorIcon from './selector-icon.vue'
import {normalizeSelectOptions, selectedOptionLabel} from './options.js'

defineOptions({inheritAttrs: false})
const props = defineProps({
  modelValue: {type: [String, Number], default: ''},
  options: {type: Array, default: () => []},
  placeholder: {type: String, default: ''},
  disabled: Boolean
})
defineEmits(['update:modelValue', 'change'])
const normalizedOptions = computed(() => normalizeSelectOptions(props.options))
const selectedLabel = computed(() => selectedOptionLabel(normalizedOptions.value, props.modelValue))
</script>

<style>
/* Scoped by component classes, including the teleported menu. No global theme replacement. */
.ui-select.el-select {
  --el-border-color: var(--ui-select-border, #dedee3);
  --el-border-color-hover: #a1a1aa;
  --el-color-primary: #71717a;
  min-width: 0;
  font-size: 13px;
}
.ui-select.el-select .el-select__wrapper {
  min-height: var(--ui-select-height, 38px);
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  box-shadow: 0 0 0 1px var(--el-border-color) inset, 0 1px 2px rgb(0 0 0 / 3%);
  gap: 10px;
  font-size: 13px;
  line-height: 20px;
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.ui-select.el-select .el-select__wrapper:hover:not(.is-disabled) { box-shadow: 0 0 0 1px #a1a1aa inset; }
.ui-select.el-select .el-select__wrapper.is-focused { box-shadow: 0 0 0 1px #a1a1aa inset, 0 0 0 3px rgb(113 113 122 / 12%); }
.ui-select.el-select .el-select__wrapper.is-disabled { opacity: .55; background: var(--el-fill-color-light); }
.ui-select.el-select .el-select__caret { width: 16px; height: 16px; color: #71717a; transform: none; transition: none; }
.ui-select.el-select .el-select__selected-item { min-width: 0; text-align: left; }
.ui-select.el-select .el-select__placeholder { color: var(--el-text-color-primary); }
.ui-select.el-select .el-select__placeholder.is-transparent { color: var(--el-text-color-placeholder); }
.ui-select-menu.el-popper {
  max-width: calc(100vw - 24px);
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
  box-shadow: 0 10px 26px rgb(0 0 0 / 10%), 0 2px 6px rgb(0 0 0 / 4%);
  overflow: hidden;
}
.ui-select-menu .el-select-dropdown { max-width: 100%; min-width: 0 !important; }
.ui-select-menu .el-select-dropdown__list { padding: 5px; }
.ui-select-menu .el-select-dropdown__item {
  display: flex; align-items: center; gap: 10px;
  min-height: 36px; height: auto; padding: 8px 10px;
  border-radius: 6px; line-height: 20px; font-size: 13px; white-space: normal;
  color: var(--el-text-color-primary); font-weight: 400;
}
.ui-select-menu .el-select-dropdown__item.is-hovering,
.ui-select-menu .el-select-dropdown__item:hover,
.ui-select-menu .el-select-dropdown__item.is-selected { background: var(--el-fill-color-light); color: var(--el-text-color-primary); }
.ui-select-menu .el-select-dropdown__item.is-selected { font-weight: 500; }
.ui-select-menu .el-select-dropdown__item.is-disabled { color: var(--el-text-color-placeholder); background: transparent; }
.ui-select-option-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ui-select-check { flex: 0 0 16px; }
html.dark .ui-select.el-select { --ui-select-border: #41414a; }
html.dark .ui-select.el-select .el-select__caret { color: #a1a1aa; }
@media (pointer: coarse) {
  .ui-select.el-select .el-select__wrapper { min-height: 44px; }
  .ui-select-menu .el-select-dropdown__item { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-select.el-select .el-select__wrapper { transition: none; }
}
</style>
