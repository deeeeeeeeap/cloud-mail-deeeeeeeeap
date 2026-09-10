// Keep option values intact; only labels are converted to display strings.
export function normalizeSelectOptions(options = []) {
  return options.map(option => typeof option === 'object' && option !== null
    ? {value: option.value, label: String(option.label ?? option.value ?? ''), disabled: Boolean(option.disabled)}
    : {value: option, label: String(option), disabled: false})
}
export function selectedOptionLabel(options, value) {
  return options.find(option => option.value === value)?.label || ''
}
