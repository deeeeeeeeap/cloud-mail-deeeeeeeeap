import { defineComponent, h, toRef } from 'vue'
import { useVirtualList } from '@vueuse/core'

const ROW_STYLE = { overflow: 'hidden' }

// 不用 @vueuse/components 的 UseVirtualList：它的外层行没有 key，可见范围平移一行，所有可见行都要
// 换成另一封邮件，而且每个 scroll 事件都整段重渲染。这里外层行按 itemKey 保持身份，只在跨过行边界时重算。
// options 只在创建时读取；itemHeight 必须是数字（传函数时 vueuse 每次滚动都 O(n) 遍历），变化时由调用方换 key 重建。
export default defineComponent({
  name: 'KeyedVirtualList',
  props: {
    list: { type: Array, required: true },
    options: { type: Object, required: true },
    itemKey: { type: Function, required: true }
  },
  setup(props, { slots, expose }) {
    const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(toRef(props, 'list'), props.options)
    const { onScroll: calculateRange, ...container } = containerProps
    const { itemHeight } = props.options
    let firstRow = -1

    // 列表变化、容器尺寸变化和 scrollTo 由 useVirtualList 自行重算，这里只需拦截滚动
    function onScroll(event) {
      const row = Math.floor(event.currentTarget.scrollTop / itemHeight)
      if (row === firstRow) return
      firstRow = row
      calculateRange()
    }

    expose({ scrollTo })
    return () => h('div', { ...container, onScroll }, [
      h('div', wrapperProps.value, list.value.map(row => h('div', {
        key: props.itemKey(row.data),
        style: ROW_STYLE
      }, slots.default?.(row))))
    ])
  }
})
