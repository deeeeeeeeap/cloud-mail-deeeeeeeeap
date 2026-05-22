<template>
  <div v-if="loading && first" class="maintenance-loading">
    <Loading/>
  </div>
  <el-scrollbar v-else class="scrollbar">
    <div class="maintenance">
      <div class="header-actions">
        <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
        <span>{{ $t('maintenanceDesc') }}</span>
      </div>

      <div class="number">
        <div class="number-item" v-for="item in summaryCards" :key="item.key">
          <div class="top">
            <div class="left">
              <div>{{ item.title }}</div>
              <div>
                <el-tag :type="item.ok ? 'success' : 'danger'">
                  {{ item.ok ? $t('normal') : $t('warning') }}
                </el-tag>
              </div>
            </div>
            <div class="right">
              <div class="count-icon">
                <Icon :icon="item.icon" width="25" height="25"/>
              </div>
            </div>
          </div>
          <div class="desc">{{ item.message }}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">{{ $t('healthIssues') }}</div>
        <el-table :data="health.checks || []" table-layout="fixed" style="width: 100%">
          <el-table-column :label="$t('tabStatus')" width="90">
            <template #default="props">
              <el-tag :type="props.row.ok ? 'success' : 'danger'">
                {{ props.row.ok ? $t('normal') : $t('warning') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="key" :label="$t('item')" width="150"/>
          <el-table-column prop="message" :label="$t('description')" min-width="260" show-overflow-tooltip/>
        </el-table>
      </div>

      <div class="panel">
        <div class="panel-title">{{ $t('safeRepair') }}</div>
        <div v-if="canRepair" class="repair-actions">
          <el-button type="primary" :loading="repairing === 'schema'" @click="repair('schema')">
            {{ $t('repairSchema') }}
          </el-button>
          <el-button type="primary" :loading="repairing === 'indexes'" @click="repair('indexes')">
            {{ $t('repairIndexes') }}
          </el-button>
          <el-button type="warning" :loading="repairing === 'search'" @click="repair('search')">
            {{ $t('rebuildSearch') }}
          </el-button>
        </div>
        <el-empty v-else :description="$t('unauthorized')" :image-size="80"/>
      </div>

      <div class="panel">
        <div class="panel-title">{{ $t('codeMaintenance') }}</div>
        <div class="panel-desc">{{ $t('codeMaintenanceDesc') }}</div>
        <div v-if="canRepair" class="repair-actions">
          <el-button type="primary" plain :loading="repairing === 'codes-rescan'" @click="repair('codes-rescan')">
            {{ $t('rescanCodes') }}
          </el-button>
          <el-button type="warning" plain :loading="repairing === 'codes-clean'" @click="repair('codes-clean')">
            {{ $t('cleanFalseCodes') }}
          </el-button>
          <el-button type="danger" plain :loading="repairing === 'codes-clear-stale'" @click="repair('codes-clear-stale')">
            {{ $t('clearStaleCodes') }}
          </el-button>
        </div>
        <el-empty v-else :description="$t('unauthorized')" :image-size="80"/>
        <div v-if="health.lastAction" class="action-result">
          {{ $t('codeMaintenanceResult', health.lastAction) }}
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">{{ $t('diagnosticDetails') }}</div>
        <el-descriptions :column="detailColumn" border>
          <el-descriptions-item label="Email Total">{{ health.details?.emailTotal ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Search Rows">{{ health.details?.emailSearchRows ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Duration">{{ health.details?.durationMs ?? '-' }}ms</el-descriptions-item>
          <el-descriptions-item label="Uses Index">{{ health.details?.usesIndex ? 'Yes' : 'No' }}</el-descriptions-item>
          <el-descriptions-item label="Missing Columns">{{ joinList(health.details?.missingEmailColumns) }}</el-descriptions-item>
          <el-descriptions-item label="Missing Indexes">{{ joinList(health.details?.missingIndexes) }}</el-descriptions-item>
        </el-descriptions>
        <div class="query-plan">{{ health.details?.queryPlan || '-' }}</div>
      </div>
    </div>
  </el-scrollbar>
</template>

<script setup>
import {computed, defineOptions, ref} from "vue";
import {Icon} from "@iconify/vue";
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
const detailColumn = window.innerWidth < 767 ? 1 : 2
const canRepair = computed(() => hasPerm('maintenance:repair'))

const summaryCards = computed(() => {
  const checks = health.value.checks || []
  const find = key => checks.find(item => item.key === key) || {ok: false, message: '-'}
  return [
    {key: 'd1', title: 'D1', icon: 'fluent:database-20-regular', ...find('d1')},
    {key: 'kv', title: 'KV', icon: 'carbon:data-base-alt', ...find('kv')},
    {key: 'schema', title: t('databaseSchema'), icon: 'eos-icons:system-ok-outlined', ...find('schema')},
    {key: 'indexes', title: t('databaseIndexes'), icon: 'fluent:flash-20-regular', ...find('indexes')}
  ]
})

function refresh() {
  loading.value = true
  maintenanceHealth().then(data => {
    health.value = data
    first.value = false
  }).finally(() => {
    loading.value = false
  })
}

function repair(action) {
  ElMessageBox.confirm(repairConfirmText(action), t('warning'), {
    type: 'warning'
  }).then(() => {
    repairing.value = action
    maintenanceRepair(action).then(data => {
      health.value = data
      ElMessage({message: t('repairSuccess'), type: 'success'})
    }).finally(() => {
      repairing.value = ''
    })
  })
}

function repairConfirmText(action) {
  if (action === 'codes-clear-stale') {
    return t('clearStaleCodesConfirm')
  }
  if (action === 'codes-rescan' || action === 'codes-clean') {
    return t('codeMaintenanceConfirm')
  }
  return t('repairConfirm')
}

function joinList(list) {
  return Array.isArray(list) && list.length > 0 ? list.join(', ') : '-'
}

refresh()
</script>

<style scoped lang="scss">
.maintenance-loading {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scrollbar {
  height: 100%;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  background: var(--extra-light-fill);
}

.maintenance {
  width: 100%;
  max-width: 100%;
  min-height: 100%;
  padding: 14px 16px 22px;
  box-sizing: border-box;
  display: grid;
  grid-auto-rows: min-content;
  gap: 14px;
  overflow-x: hidden;
  background: var(--extra-light-fill);

  @media (max-width: 1024px) {
    padding: 12px 12px 22px;
    gap: 12px;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--el-text-color-secondary);
  min-width: 0;

  .icon {
    flex-shrink: 0;
    cursor: pointer;
    color: var(--el-text-color-primary);
  }

  span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.number {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;

  @media (max-width: 1366px) {
    gap: 12px;
  }

  @media (max-width: 767px) {
    grid-template-columns: 1fr;
  }
}

.number-item,
.panel {
  background: var(--el-bg-color);
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
  min-width: 0;
  overflow: hidden;
}

.number-item {
  padding: 15px 18px;

  .top {
    display: grid;
    justify-content: space-between;
    align-content: center;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .left {
    display: grid;
    gap: 7px;
    min-width: 0;
  }

  .right {
    display: grid;
    align-items: center;
  }

  .count-icon {
    top: 3px;
    position: relative;
    display: grid;
    align-items: center;
    padding: 12px;
    border-radius: 8px;
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
  }

  .desc {
    padding-top: 10px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.panel {
  padding: 14px 16px;
}

.panel-title {
  font-size: 17px;
  font-weight: 500;
  padding-bottom: 12px;
}

.panel-desc {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.5;
  margin-top: -4px;
  margin-bottom: 12px;
}

.repair-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.action-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
  font-size: 13px;
  line-height: 1.5;
}

.query-plan {
  margin-top: 12px;
  padding: 12px;
  border-radius: 6px;
  background: var(--extra-light-fill);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  word-break: break-all;
}

:deep(.el-table .cell) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

:deep(.el-table),
:deep(.el-table__inner-wrapper),
:deep(.el-table__body-wrapper),
:deep(.el-scrollbar__view) {
  max-width: 100%;
}

:deep(.el-scrollbar__wrap) {
  overflow-x: hidden !important;
}

:deep(.el-descriptions),
:deep(.el-descriptions__body),
:deep(.el-descriptions__table) {
  width: 100%;
  max-width: 100%;
}

:deep(.el-descriptions__content) {
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
}

:deep(.el-descriptions__label) {
  width: 145px;
}
</style>
