<template>
  <div v-if="loading && first" class="maintenance-loading"><Loading/></div>
  <el-scrollbar v-else class="scrollbar">
    <div class="maintenance" :aria-busy="loading">
      <div class="maintenance-heading">
        <p>{{ $t('maintenanceDesc') }}</p>
        <el-button :loading="loading" :disabled="!!repairing" @click="refresh">{{ $t('setupRefreshStatus') }}</el-button>
      </div>
      <el-alert v-if="loadFailed" :title="$t('listLoadFailed')" type="error" :closable="false" show-icon/>
      <section v-if="health.checks" class="panel health-panel">
        <div class="panel-heading">
          <h2>{{ $t('healthIssues') }}</h2>
          <span class="health-summary">{{ $t('healthSummary', {passed: healthyCount, total: health.checks.length}) }}</span>
        </div>
        <ul class="health-checks">
          <li v-for="check in health.checks" :key="check.key" class="health-check">
            <div class="check-heading">
              <h3>{{ checkTitles[check.key] ? $t(checkTitles[check.key]) : check.key }}</h3>
              <span class="check-status" :class="check.ok ? 'is-ok' : 'needs-attention'">
                <span aria-hidden="true">{{ check.ok ? '✓' : '!' }}</span>
                {{ check.ok ? $t('normal') : $t('warning') }}
              </span>
            </div>
            <p>{{ check.message }}</p>
          </li>
        </ul>
      </section>

      <div v-if="health.lastAction" class="action-result" role="status">{{ actionResultText(health.lastAction) || $t('repairSuccess') }}</div>
      <div class="maintenance-actions">
        <section v-for="group in actionGroups" :key="group.title" class="panel action-panel">
          <div class="action-heading"><span class="action-mark"><Icon :icon="group.icon" width="22" height="22"/></span><h2>{{ $t(group.title) }}</h2></div>
          <p class="panel-desc">{{ $t(group.description) }}</p>
          <div v-if="canRepair" class="repair-actions">
            <el-button v-for="[action, label] in group.actions" :key="action"
                :loading="repairing === action" :disabled="loading || (!!repairing && repairing !== action)"
                :type="action === 'codes-clear-stale' ? 'danger' : ''" plain @click="repair(action)">
              {{ $t(label) }}
            </el-button>
          </div>
          <p v-else class="panel-desc">{{ $t('unauthorized') }}</p>
        </section>
      </div>

      <section v-if="canRepair" class="panel manual-panel" :class="{'is-open': manualOpen}">
        <button
          id="manual-delivery-toggle"
          class="manual-summary"
          type="button"
          :aria-expanded="manualOpen"
          aria-controls="manual-delivery-content"
          @click="manualOpen = !manualOpen"
        >
          <span class="manual-summary-leading">
            <span class="manual-summary-mark"><Icon icon="cloud-mail:send" width="18" height="18"/></span>
            <span class="manual-summary-label">{{ $t('manualDelivery') }}</span>
          </span>
          <DropdownChevron class="manual-chevron" :expanded="manualOpen"/>
        </button>
        <div id="manual-delivery-content" class="manual-panel-body" :class="{'is-open': manualOpen}" :inert="!manualOpen" :aria-hidden="!manualOpen">
          <div class="manual-panel-inner">
            <p class="panel-desc">{{ $t('manualDeliveryDesc') }}</p>
            <div class="repair-actions">
              <el-button v-for="[action, label] in manualActions" :key="action" type="danger" plain
                  :loading="repairing === action" :disabled="loading || (!!repairing && repairing !== action)" @click="repair(action)">
                {{ $t(label) }}
              </el-button>
            </div>
          </div>
        </div>
      </section>

      <details v-if="health.details" class="panel diagnostics">
        <summary>{{ $t('diagnosticDetails') }}</summary>
        <dl class="diagnostic-grid">
          <div><dt>{{ $t('diagnosticEmailTotal') }}</dt><dd>{{ health.details.emailTotal ?? '—' }}</dd></div>
          <div><dt>{{ $t('diagnosticSearchRows') }}</dt><dd>{{ health.details.emailSearchRows ?? '—' }}</dd></div>
          <div><dt>{{ $t('diagnosticAttempts') }}</dt><dd>{{ health.details.deliveryAttempts?.total ?? '—' }}</dd></div>
          <div><dt>{{ $t('diagnosticUnknown') }}</dt><dd>{{ health.details.deliveryAttempts?.counts?.UNKNOWN ?? '—' }}</dd></div>
          <div><dt>{{ $t('diagnosticPending') }}</dt><dd>{{ health.details.deliveryAttempts?.counts?.PENDING_ACK ?? '—' }}</dd></div>
          <div><dt>{{ $t('diagnosticDuration') }}</dt><dd>{{ health.details.durationMs ?? '—' }} ms</dd></div>
          <div><dt>{{ $t('diagnosticIndex') }}</dt><dd>{{ health.details.usesIndex == null ? '—' : health.details.usesIndex ? $t('yes') : $t('no') }}</dd></div>
          <div><dt>{{ $t('diagnosticColumns') }}</dt><dd>{{ joinList(health.details.missingEmailColumns) }}</dd></div>
          <div><dt>{{ $t('diagnosticIndexes') }}</dt><dd>{{ joinList(health.details.missingIndexes) }}</dd></div>
        </dl>
        <pre class="query-plan">{{ health.details.queryPlan || '—' }}</pre>
      </details>
    </div>
  </el-scrollbar>
</template>

<script setup>
import DropdownChevron from "@/components/dropdown-chevron/index.vue";
import {computed, defineOptions, ref} from "vue";
import {Icon} from '@iconify/vue';
import {ElMessage, ElMessageBox} from "element-plus";
import Loading from "@/components/loading/index.vue";
import {maintenanceHealth, maintenanceRepair} from "@/request/maintenance.js";
import {hasPerm} from "@/perm/perm.js";
import {useI18n} from "vue-i18n";

defineOptions({
  name: 'maintenance'
})

const {t} = useI18n()
const loading = ref(true)
const first = ref(true)
const repairing = ref('')
const health = ref({})
const loadFailed = ref(false)
const manualOpen = ref(false)
const canRepair = computed(() => hasPerm('maintenance:repair'))

const healthyCount = computed(() => (health.value.checks || []).filter(check => check.ok).length)
const actionGroups = [
  {title: 'safeRepair', icon: 'cloud-mail:tools', description: 'safeRepairDesc', actions: [
    ['schema', 'repairSchema'], ['indexes', 'repairIndexes'], ['search', 'rebuildSearch']
  ]},
  {title: 'deliveryMaintenance', icon: 'cloud-mail:send', description: 'deliveryMaintenanceDesc', actions: [
    ['delivery-reconcile', 'reconcileDelivery'], ['receive-recover', 'recoverReceive']
  ]},
  {title: 'codeMaintenance', icon: 'cloud-mail:code', description: 'codeMaintenanceDesc', actions: [
    ['codes-rescan', 'rescanCodes'], ['codes-clean', 'cleanFalseCodes'], ['codes-clear-stale', 'clearStaleCodes']
  ]}
]
const manualActions = [['delivery-ack-unknown', 'ackUnknownDelivery'], ['delivery-fail-unknown', 'failUnknownDelivery']]
const checkTitles = {
  d1: 'setupCheckD1', kv: 'setupCheckKv', r2: 'oss', cloudflareEmail: 'cloudflareEmailBinding',
  schema: 'databaseSchema', indexes: 'databaseIndexes', emailSearch: 'searchTable',
  deliveryAttempts: 'deliveryMaintenance', settingCache: 'settingsCache'
}

async function refresh() {
  if (loading.value && !first.value) return
  loading.value = true
  loadFailed.value = false
  try {
    health.value = await maintenanceHealth()
  } catch {
    loadFailed.value = true
  } finally {
    first.value = false
    loading.value = false
  }
}

async function repair(action) {
  if (repairing.value || loading.value) return
  try {
    await ElMessageBox.confirm(repairConfirmText(action), t('warning'), {type: 'warning'})
  } catch {
    return
  }
  repairing.value = action
  try {
    const data = await maintenanceRepair(action)
    health.value = data
    loadFailed.value = false
    ElMessage({message: actionResultText(data.lastAction) || t('repairSuccess'), type: 'success'})
  } catch {
    // The API interceptor displays request failures; keep the last successful report.
  } finally {
    repairing.value = ''
  }
}

function repairConfirmText(action) {
  if (action === 'delivery-ack-unknown' || action === 'delivery-fail-unknown') {
    return t('unknownDeliveryConfirm')
  }
  if (action === 'codes-clear-stale') {
    return t('clearStaleCodesConfirm')
  }
  if (action === 'codes-rescan' || action === 'codes-clean') {
    return t('codeMaintenanceConfirm')
  }
  return t('repairConfirm')
}

function actionResultText(result) {
  if (!result) return ''
  if (result.action === 'codes-clear-stale') {
    return t('clearStaleCodesResult', result)
  }
  if (result.action === 'codes-rescan' || result.action === 'codes-clean') {
    return t('codeMaintenanceResult', result)
  }
  if (result.action === 'delivery-ack-unknown' || result.action === 'delivery-fail-unknown') {
    return t('unknownDeliveryResult', result)
  }
  if (result.action === 'receive-recover') {
    return t('receiveRecoverResult', result)
  }
  if (result.action === 'delivery-reconcile') {
    return t('deliveryReconcileResult', result)
  }
  return ''
}

function joinList(list) {
  return Array.isArray(list) && list.length > 0 ? list.join(', ') : '-'
}

refresh()
</script>

<style scoped lang="scss">
.maintenance-loading { height: 100%; display: grid; place-items: center; }
.scrollbar { height: 100%; background: var(--extra-light-fill); }
.maintenance { max-width: 1440px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
.maintenance-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.maintenance-heading p, .panel-desc { color: var(--secondary-text-color); font-size: 13px; line-height: 1.65; }
.maintenance-heading .el-button { flex-shrink: 0; }
.panel { min-width: 0; padding: 24px; border: 1px solid var(--el-border-color-light); border-radius: var(--radius-lg); background: var(--el-bg-color); box-shadow: var(--shadow-card); }
h2 { font-size: 15px; font-weight: 600; }
.panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 20px; }
.health-summary { font-size: 12px; color: var(--regular-text-color); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--extra-light-fill); font-variant-numeric: tabular-nums; }
.health-checks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 24px; }
.health-check { padding: 16px 0; border-top: 1px solid var(--el-border-color-lighter); }
.health-check { min-width: 0; }
.check-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.check-heading h3 { font-size: 13px; font-weight: 500; }
.check-status { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; font-size: 12px; }
.check-status > span { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 11px; }
.is-ok { color: var(--el-color-success-dark-2); > span { background: var(--el-color-success-light-9); } }
.needs-attention { color: var(--el-color-danger); > span { background: var(--el-color-danger-light-9); } }
.health-check p { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--secondary-text-color); overflow-wrap: anywhere; }
.maintenance-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: stretch; }
.action-panel { position: relative; display: grid; gap: 12px; }
.action-heading { display: flex; align-items: center; gap: 12px; }
.action-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); flex-shrink: 0; }
.repair-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.repair-actions .el-button { height: auto; min-height: 34px; margin: 0; padding: 8px 12px; white-space: normal; text-align: left; line-height: 1.4; }
.manual-panel { padding: 0; overflow: hidden; }
.manual-summary { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 16px; min-height: 68px; padding: 16px 20px; border: 0; color: var(--el-text-color-primary); background: transparent; cursor: pointer; text-align: left; transition: background-color 180ms ease; }
.manual-summary:hover { background: var(--el-fill-color-light); }
.manual-summary:focus-visible { outline: 2px solid var(--el-text-color-secondary); outline-offset: -3px; }
.manual-summary-leading { display: inline-flex; align-items: center; gap: 12px; min-width: 0; }
.manual-summary-mark { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius-md); color: var(--el-text-color-secondary); background: var(--el-fill-color-light); }
.manual-summary-label { font-size: 14px; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
.manual-panel-body { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 300ms cubic-bezier(.22, .75, .2, 1), opacity 180ms ease; }
.manual-panel-body.is-open { grid-template-rows: 1fr; opacity: 1; }
.manual-panel-inner { min-height: 0; overflow: hidden; padding: 0 20px; transition: padding 300ms cubic-bezier(.22, .75, .2, 1); }
.manual-panel-body.is-open .manual-panel-inner { padding: 0 20px 20px; }
.manual-panel-inner .panel-desc { margin: 0 0 14px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.manual-panel .repair-actions .el-button { min-height: 38px; padding: 9px 14px; }
.diagnostics summary { font-size: 14px; font-weight: 500; }
.diagnostic-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 20px; }
.diagnostic-grid dt { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px; }
.diagnostic-grid dd { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.query-plan { margin-top: 20px; padding: 14px; border-radius: var(--radius-md); background: var(--extra-light-fill); font-size: 12px; color: var(--regular-text-color); white-space: pre-wrap; overflow-wrap: anywhere; }
.action-result { padding: 12px 16px; border: 1px solid var(--el-color-success-light-7); border-radius: var(--radius-md); background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); font-size: 13px; }
@media (max-width: 1100px) {
  .maintenance-actions { grid-template-columns: 1fr; }
  .health-checks, .diagnostic-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .maintenance { padding: 16px; gap: 16px; }
  .maintenance-heading { align-items: start; gap: 12px; }
  .panel { padding: 16px; }
  .manual-panel { padding: 0; }
  .manual-summary { padding: 14px 16px; }
  .manual-panel .repair-actions .el-button { min-height: 44px; }
  .manual-panel-inner { padding: 0 16px; }
  .manual-panel-body.is-open .manual-panel-inner { padding: 0 16px 16px; }
  .health-checks { grid-template-columns: 1fr; gap: 16px; }
  .health-check + .health-check { padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }
  .maintenance-actions { gap: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .manual-panel,
  .manual-summary,
  .manual-chevron,
  .manual-panel-body,
  .manual-panel-inner { transition-duration: 0.01ms; }
}
</style>
