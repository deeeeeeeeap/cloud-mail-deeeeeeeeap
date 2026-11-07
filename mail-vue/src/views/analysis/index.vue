<template>
  <div v-if="analysisLoading" class="analysis-loading">
    <el-empty v-if="loadFailed" :description="$t('listLoadFailed')">
      <el-button type="primary" @click="retryLoad">{{ $t('retry') }}</el-button>
    </el-empty>
    <loading v-else/>
  </div>
  <el-scrollbar v-else style="height: 100%;">
    <div class="analysis">
      <div class="number">
        <div class="number-item">
          <div class="top">
            <div class="left">
              <div>{{ $t('totalReceived') }}</div>
              <div>
                <el-statistic :formatter="value => Math.round(value)" :value="receiveData"/>
              </div>
            </div>
            <div class="right">
              <div class="count-icon">
                <Icon icon="hugeicons:mailbox-01" width="25" height="25"></Icon>
              </div>
            </div>
          </div>
          <div class="delete-ratio">
            <div>{{ $t('active') }} <span class="normal">{{ numberCount.normalReceiveTotal }}</span></div>
            <div>{{ $t('deleted') }} <span class="deleted">{{ numberCount.delReceiveTotal }}</span></div>
          </div>
        </div>
        <div class="number-item">
          <div class="top">
            <div class="left">
              <div>{{ $t('totalSent') }}</div>
              <div>
                <el-statistic :formatter="value => Math.round(value)" :value="sendData"/>
              </div>
            </div>
            <div class="right">
              <div class="count-icon">
                <Icon icon="cil:send" width="25" height="25"></Icon>
              </div>
            </div>
          </div>
          <div class="delete-ratio">
            <div>{{ $t('active') }} <span class="normal">{{ numberCount.normalSendTotal }}</span></div>
            <div>{{ $t('deleted') }} <span class="deleted">{{ numberCount.delSendTotal }}</span></div>
          </div>
        </div>
        <div class="number-item">
          <div class="top">
            <div class="left">
              <div>{{ $t('totalMailboxes') }}</div>
              <div>
                <el-statistic :formatter="value => Math.round(value)" :value="accountData"/>
              </div>
            </div>
            <div class="right">
              <div class="count-icon">
                <Icon icon="lets-icons:e-mail" width="23" height="23"></Icon>
              </div>
            </div>
          </div>
          <div class="delete-ratio">
            <div>{{ $t('active') }} <span class="normal">{{ numberCount.normalAccountTotal }}</span></div>
            <div>{{ $t('deleted') }} <span class="deleted">{{ numberCount.delAccountTotal }}</span></div>
          </div>
        </div>
        <div class="number-item">
          <div class="top">
            <div class="left">
              <div>{{ $t('totalUsers') }}</div>
              <div>
                <el-statistic :formatter="value => Math.round(value)" :value="userData"/>
              </div>
            </div>
            <div class="right">
              <div class="count-icon">
                <Icon icon="iconoir:user" width="25" height="25"></Icon>
              </div>
            </div>
          </div>
          <div class="delete-ratio">
            <div>{{ $t('active') }} <span class="normal">{{ numberCount.normalUserTotal }}</span></div>
            <div>{{ $t('deleted') }} <span class="deleted">{{ numberCount.delUserTotal }}</span></div>
          </div>
        </div>
      </div>
      <div class="picture">
        <div class="picture-item">
          <div class="title" style="display: flex;justify-content: space-between;">
            <span>{{ $t('emailSource') }}</span>
            <span class="source-button" v-if="false">
              <el-radio-group v-model="checkedSourceType">
                <el-radio-button label="发件人" value="sender"/>
                <el-radio-button label="邮箱" value="email"/>
              </el-radio-group>
            </span>
          </div>
          <div class="sender-pie" ref="senderPieElement">

          </div>
        </div>
        <div class="picture-item">
          <div class="title">{{ $t('userGrowth') }}</div>
          <div class="increase-line" ref="increaseLineElement">

          </div>
        </div>
      </div>
      <div class="picture-cs">
        <div class="picture-cs-item">
          <div class="title">{{ $t('emailGrowth') }}</div>
        <div class="email-column" ref="emailColumnElement"></div>
        </div>
        <div class="picture-cs-item">
          <div class="title">{{ $t('sentToday') }}</div>
        <div class="send-count" ref="sendGaugeElement"></div>
        </div>
      </div>
    </div>
  </el-scrollbar>
</template>

<script setup>
import {Icon} from "@iconify/vue/offline";
import {useTransition} from "@vueuse/core";
import {defineOptions, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch, computed} from "vue";
import echarts from "@/echarts/index.js";
import dayjs from "dayjs";
import {analysisEcharts} from "@/request/analysis.js";
import {useUiStore} from "@/store/ui.js";
import loading from "@/components/loading/index.vue";
import {useRoute} from "vue-router";
import {useI18n} from 'vue-i18n';
import {formatSenderTooltip} from './tooltip.js';
import {createChartRuntime} from './chart-runtime.js';

defineOptions({
  name: 'analysis'
})

const {t} = useI18n();
const route = useRoute();
const uiStore = useUiStore()
const checkedSourceType = ref('sender')
const receiveTotal = ref(0)
const sendTotal = ref(0)
const accountTotal = ref(0)
const userTotal = ref(0)
const analysisLoading = ref(true)
const loadFailed = ref(false)

const numberCount = reactive({
  normalReceiveTotal: 0,
  normalSendTotal: 0,
  normalAccountTotal: 0,
  normalUserTotal: 0,
  delReceiveTotal: 0,
  delSendTotal: 0,
  delAccountTotal: 0,
  delUserTotal: 0
})


const receiveData = useTransition(receiveTotal, {
  duration: 1500,
})

const sendData = useTransition(sendTotal, {
  duration: 1500,
})

const accountData = useTransition(accountTotal, {
  duration: 1500,
})

const userData = useTransition(userTotal, {
  duration: 1500,
})

const senderData = ref(null)
const userLineData = reactive({
  xdata: [],
  sdata: []
})

const emailColumnData = {
  receiveData: [],
  sendData: [],
  daysData: []
}

const senderPieElement = ref(null)
const increaseLineElement = ref(null)
const emailColumnElement = ref(null)
const sendGaugeElement = ref(null)
const chartRuntime = createChartRuntime({
  createChart: element => echarts.init(element)
})

const topic = computed(() => {
  // Read the shared palette after Vue applies the selected theme.
  uiStore.dark
  const styles = getComputedStyle(document.documentElement)
  const color = name => styles.getPropertyValue(name).trim()
  return {
    color: color('--el-text-color-primary'),
    background: color('--el-bg-color'),
    borderColor: color('--el-bg-color'),
    scaleLineColor: color('--dark-border'),
    crossColor: color('--secondary-text-color'),
    axisColor: color('--secondary-text-color'),
    splitLineColor: color('--el-border-color'),
    gaugeSplitLine: color('--regular-text-color'),
    containerBackground: color('--el-color-primary-light-9')
  }
})
let daySendTotal = 0
let chartRevision = 0
let optionDirty = false
let dataReady = false
let pageActive = true
let unmounted = false

onMounted(() => {
  chartRuntime.activate(chartElements())
  loadAnalysis()
})

function retryLoad() {
  loadFailed.value = false
  loadAnalysis()
}

function loadAnalysis() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  analysisEcharts(timeZone).then(data => {
    if (unmounted) return
    receiveTotal.value = data.numberCount.receiveTotal
    sendTotal.value = data.numberCount.sendTotal
    accountTotal.value = data.numberCount.accountTotal
    userTotal.value = data.numberCount.userTotal
    numberCount.normalReceiveTotal = data.numberCount.normalReceiveTotal
    numberCount.normalSendTotal = data.numberCount.normalSendTotal
    numberCount.normalAccountTotal = data.numberCount.normalAccountTotal
    numberCount.normalUserTotal = data.numberCount.normalUserTotal
    numberCount.delReceiveTotal = data.numberCount.delReceiveTotal
    numberCount.delSendTotal = data.numberCount.delSendTotal
    numberCount.delAccountTotal = data.numberCount.delAccountTotal
    numberCount.delUserTotal = data.numberCount.delUserTotal
    senderData.value = data.receiveRatio.nameRatio.map(item => {
      return {
        name: item.name || ' ',
        value: item.total
      }
    })

    userLineData.xdata = data.userDayCount.map(item => dayjs(item.date).format("M.D"));
    userLineData.sdata = data.userDayCount.map(item => item.total)

    emailColumnData.daysData = data.emailDayCount.receiveDayCount.map(item => dayjs(item.date).format("M.D"))
    emailColumnData.receiveData = data.emailDayCount.receiveDayCount.map(item => item.total)
    emailColumnData.sendData = data.emailDayCount.sendDayCount.map(item => item.total)
    daySendTotal = data.daySendTotal
    dataReady = true
    chartRevision++
    optionDirty = true
    analysisLoading.value = false
    nextTick(() => {
      if (!pageActive || unmounted) return
      chartRuntime.activate(chartElements())
      updateCharts()
    })
  }).catch(e => {
    console.error('统计数据加载失败', e)
    loadFailed.value = true
  })
}

watch(() => uiStore.asideShow, () => {
  if (window.innerWidth > 1024) {
    chartRuntime.scheduleResize()
  }
})

onActivated(() => {
  pageActive = true
  chartRuntime.activate(chartElements())
  if (dataReady && optionDirty) updateCharts()
  chartRuntime.scheduleResize()
})

onDeactivated(() => {
  pageActive = false
  chartRuntime.deactivate()
})

onUnmounted(() => {
  unmounted = true
  pageActive = false
  chartRuntime.dispose()
})

watch(() => uiStore.dark, () => {
  chartRevision++
  optionDirty = true
  if (dataReady && pageActive && route.name === 'analysis') {
    nextTick(updateCharts)
  }
})

function chartElements() {
  return [senderPieElement.value, increaseLineElement.value, emailColumnElement.value, sendGaugeElement.value]
    .filter(Boolean)
}

function updateCharts() {
  if (route.name !== 'analysis') return
  createSenderPie()
  createIncreaseLine()
  createEmailColumnChart();
  createSendGauge();
  optionDirty = false
}

const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '12px sans-serif';

function truncateTextByWidth(text, maxWidth = 140) {

  let width = measureCtx.measureText(text).width;
  if (width <= maxWidth) return text;

  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += text[i];
    if (measureCtx.measureText(result + '…').width > maxWidth) {
      return result.slice(0, -1) + '…';
    }
  }
  return text;
}

function createSenderPie() {
  let option = {
    tooltip: {
      trigger: 'item',
      textStyle: {
        color: topic.value.color
      },
      backgroundColor: topic.value.background,
      formatter: formatSenderTooltip
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      left: '10',
      top: '20',
      textStyle: {
        color: topic.value.color
      },
      formatter: function (name) {
        return truncateTextByWidth(name)
      }
    },
    series: [
      {
        data: senderData.value,
        name: '',
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['72%', '45%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 4,
          borderColor: topic.value.borderColor,
          borderWidth: 2
        },
        label: {
          show: false,
          position: 'outside', // 标签显示在外部
          formatter: '{d}%',  // 显示名称和占比
          color: '#333',
          fontSize: 14  // 设置字体大小
        },
        emphasis: {
          label: {
            show: false,
            fontSize: 40,
            fontWeight: 'bold'
          }
        },
        labelLine: {
          show: true
        },
        color: ['#3CB2FF', '#13DEB9', '#FBBF24', '#FF7F50', '#BAE6FD', '#C084FC'] // 添加符合主题的配色
      }
    ]
  }
  chartRuntime.setOption('senderPie', senderPieElement.value, option, chartRevision)
}

function createIncreaseLine() {
  let option = {
    tooltip: {
      trigger: 'axis', // 设置触发方式为 'axis'，在坐标轴上显示信息
      axisPointer: {
        type: 'cross', // 指示器的类型为交叉型，适用于折线图等
        crossStyle: {
          color: topic.value.crossColor// 设置指示器线的颜色
        },
        lineStyle: {
          color: topic.value.crossColor         // ← 竖线颜色
        },
        axis: 'x',
      },
      formatter: function (params) {
        let result = ''
        params.forEach(item => {
          result = `${item.marker} ${t('growthTotalUsers')} ${item.value}`;
        });
        return result;
      },
      backgroundColor: topic.value.background,  // 设置背景颜色
      borderColor: topic.value.splitLineColor,      // 设置边框颜色
      borderWidth: 1,           // 设置边框宽度
      padding: 10,              // 设置内边距
      textStyle: {
        color: topic.value.color,          // 设置文字颜色
      }
    },
    grid: {
      top: '8%',
      right: '20',
      left: '35',
      bottom: '35'
    },
    xAxis: {
      type: 'category',
      data: userLineData.xdata,
      axisTick: {
        show: false,
        alignWithLabel: false,  // 刻度线与标签对齐,
        lineStyle: {
          color: topic.value.axisColor,
        }
      },
      axisPointer: {
        label: {
          show: false
        }
      },
      axisLine: {
        lineStyle: {
          color: topic.value.axisColor,
          width: 1,
          type: 'solid'
        }
      },
      axisLabel: {
        formatter: function (value, index) {
          if (index === 0) {
            return '      ' + value;
          }
          if (index === userLineData.xdata.length - 1) {
            return value + '   '
          }
          return value;
        },

      },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        margin: 5, // 增加y轴刻度数字与网格线之间的间距
      },
      boundaryGap: [0, 0.1],
      max: (params) => {
        if (params.max < 8) {
          return 10
        }
      },
      axisLine: {
        show: true,
        lineStyle: {
          color: topic.value.axisColor,
          width: 1,
        }
      },
      axisPointer: {
        label: {
          show: true,
          formatter: (e) => {
            return Math.round(e.value)
          }
        }
      },
      splitLine: {
        show: true, // 显示网格线
        lineStyle: {
          type: 'dashed', // 设置网格线为虚线
          color: topic.value.scaleLineColor   // 设置虚线的颜色
        }
      }
    },
    series: [
      {

        data: userLineData.sdata,
        type: 'line',
        smooth: 0.1,
        symbol: 'none',
        lineStyle: {
          color: '#1D84FF',
          width: 2.5
        },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            {
              offset: 0,
              color: 'rgba(29, 132, 255, 0.3)'
            },
            {
              offset: 1,
              color: 'rgba(29, 132, 255, 0.03)'
            }
          ])
        },
        color: ['#1D84FF'],
      }
    ]
  };
  const changed = chartRuntime.setOption(
    'increaseLine',
    increaseLineElement.value,
    option,
    chartRevision
  );
  const increaseLine = chartRuntime.getChart('increaseLine')
  if (!changed || !increaseLine) return

  let max = increaseLine.getModel().getComponent('yAxis', 0).axis.scale.getExtent()[1];

  let left = 35

  if (max > 99) left = 42
  if (max > 999) left = 51
  if (max > 9999) left = 58
  if (max > 99999) left = 66

  increaseLine.setOption({
    grid: {
      left: left
    }
  });
}

function createEmailColumnChart() {
  const option = {
    tooltip: {
      textStyle: {
        color: topic.value.color
      },
      backgroundColor: topic.value.background,
      formatter: function (params) {
        params.marker
        return `${params.marker} ${params.seriesName}: ${params.value}`
      }
    },
    legend: {
      data: [t('emailReceived'), t('emailSent')],
      top: '0',
      textStyle: {
        color: topic.value.color,  // 图例文字颜色
      }
    },
    grid: {
      left: '18',
      right: '18',
      bottom: '15',
      top: '50',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: emailColumnData.daysData,
      axisTick: {
        show: false,
      },
      axisLine: {
        show: true,
        lineStyle: {
          color: topic.value.axisColor,
          width: 1,
        }
      },
    },
    yAxis: {
      max: (params) => {
        if (params.max < 8) {
          return 10
        }
      },
      splitLine: {
        show: true,
        lineStyle: {
          color: topic.value.splitLineColor,  // ← 横线颜色
          type: 'solid',    // dashed=虚线，solid=实线
          width: 1
        }
      },
      axisLine: {
        show: true,
        lineStyle: {
          color: topic.value.axisColor,
          width: 0,
        }
      },
      type: 'value',
      boundaryGap: [0, 0.1],
    },
    series: [
      {
        name: t('emailReceived'),
        type: 'bar',
        stack: 'total', // 堆叠组标识（必须相同）
        barWidth: '60%',
        barMaxWidth: 30,
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.3)',
          }
        },
        data: emailColumnData.receiveData,
        itemStyle: {
          color: '#3CB2FF',
        }
      },
      {
        name: t('emailSent'),
        type: 'bar',
        stack: 'total', // 堆叠组标识（必须相同）
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.3)'
          }
        },
        data: emailColumnData.sendData,
        itemStyle: {
          color: '#13deb9',
        }
      }
    ]
  };

  chartRuntime.setOption('emailColumn', emailColumnElement.value, option, chartRevision);
}

function createSendGauge() {
  let option = {
    tooltip: {
      textStyle: {
        color: topic.value.color
      },
      backgroundColor: topic.value.background
    },
    series: [{
      name: t('sentToday'),
      type: 'gauge',
      max: 100,
      // 进度条颜色（新增）
      progress: {
        show: true,
        roundCap: true,
        itemStyle: {
          color: '#3CB2FF'
        }
      },
      // 指针颜色（新增）
      pointer: {
        itemStyle: {
          color: '#3CB2FF'
        }
      },
      axisLabel: {
        color: topic.value.gaugeSplitLine,
      },
      // 轴线背景色（新增）
      axisLine: {
        roundCap: true,
        lineStyle: {
          color: [[1, topic.value.containerBackground]]
        }
      },
      splitLine: {
        lineStyle: {
          color: topic.value.gaugeSplitLine, // 大刻度线颜色
        }
      },
      // 刻度颜色（新增）
      axisTick: {
        lineStyle: {
          color: topic.value.axisColor
        }
      },
      // 中心文字颜色（新增）
      detail: {
        valueAnimation: true,
        formatter: '{value}',
        color: topic.value.color // 黑色文字
      },
      data: [{
        value: daySendTotal,
        name: t('total'),
        // 名称标签颜色（新增）
        title: {
          color: topic.value.color  // 灰色标签
        }
      }]
    }],
    color: ['#3CB2FF']
  };
  chartRuntime.setOption('sendGauge', sendGaugeElement.value, option, chartRevision);
}


</script>
<style>
.percentage-value {
  display: block;
  margin-top: 10px;
  font-size: 28px;
}

.percentage-label {
  display: block;
  margin-top: 10px;
  font-size: 12px;
}
</style>
<style scoped lang="scss">
.analysis-loading {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.analysis {
  height: 100%;
  padding: 20px 20px 30px;
  gap: 20px;
  background: var(--extra-light-fill);
  display: grid;
  grid-auto-rows: min-content;
  @media (max-width: 1024px) {
    padding: 15px 15px 30px;
    gap: 15px
  }

  .title {
    margin-top: 10px;
    margin-left: 15px;
    font-size: 18px;
    font-weight: 500;
  }

  .number {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 20px;
    @media (max-width: 1366px) {
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    @media (max-width: 767px) {
      grid-template-columns: 1fr;
    }

    .number-item {
      background: var(--el-bg-color);
      border-radius: var(--radius-lg);
      border: 1px solid var(--el-border-color-light);
      padding: 21px 20px;

      .top {
        display: grid;
        justify-content: space-between;
        align-content: center;
        grid-template-columns: auto auto;

        .left {
          display: grid;
          gap: 5px;
          grid-auto-rows: min-content;

          > div:first-child {
            font-size: 15px;
          }

          > div:last-child {
            font-size: 13px;
          }

          :deep(.el-statistic__number) {
            font-size: 26px;
          }
        }

        .right {
          display: grid;
          align-items: center;

          .count-icon {
            top: 3px;
            position: relative;
            display: grid;
            align-items: center;
            padding: 14px;
            border-radius: var(--radius-lg);
            background: var(--el-color-primary-light-9);
            color: var(--el-color-primary);
          }
        }

      }

      .delete-ratio {
        width: 100%;
        display: grid;
        grid-template-columns:  auto auto;
        justify-content: start;
        gap: 20px;
        padding-top: 5px;
        font-size: 14px;

        .normal {
          width: fit-content;
          color: var(--el-color-success);
          font-weight: bold;;
          margin-left: 3px;
        }

        .deleted {
          width: fit-content;
          color: var(--el-color-danger);
          font-weight: bold;;
          margin-left: 3px;
        }
      }

    }
  }

  .picture {
    display: grid;
    grid-template-columns: 500px 1fr;
    gap: 20px;
    @media (max-width: 1620px) {
      grid-template-columns: 1fr;
    }
    @media (max-width: 1024px) {
      gap: 15px;
    }

    .picture-item {
      background: var(--el-bg-color);
      border-radius: var(--radius-lg);
      border: 1px solid var(--el-border-color-light);

      .source-button {
        padding-right: 15px;
        display: flex;
        align-items: start;

        :deep(.el-radio-button__inner) {
          padding: 6px 10px;
        }
      }

      .sender-pie {
        height: 350px;
        @media (max-width: 767px) {
          height: 200px;
        }
      }

      .increase-line {
        height: 350px;
        @media (max-width: 767px) {
          height: 280px;
        }
      }
    }
  }

  .picture-cs {
    display: grid;
    grid-template-columns: 1fr 500px;
    gap: 20px;
    @media (max-width: 1620px) {
      grid-template-columns: 1fr;
      gap: 15px;
    }

    .picture-cs-item {
      background: var(--el-bg-color);
      border-radius: var(--radius-lg);
      border: 1px solid var(--el-border-color-light);

      .send-count {
        height: 350px;
        @media (max-width: 767px) {
          height: 320px;
        }
      }

      .email-column {
        height: 350px;
        @media (max-width: 767px) {
          height: 250px;
        }
      }
    }
  }
}

</style>




















