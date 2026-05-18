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
        <el-table :data="health.checks || []" style="width: 100%">
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
  ElMessageBox.confirm(t('repairConfirm'), t('warning'), {
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
  background: var(--extra-light-fill);
}

.maintenance {
  min-height: 100%;
  padding: 20px 20px 30px;
  display: grid;
  grid-auto-rows: min-content;
  gap: 20px;
  background: var(--extra-light-fill);

  @media (max-width: 1024px) {
    padding: 15px 15px 30px;
    gap: 15px;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--el-text-color-secondary);

  .icon {
    cursor: pointer;
    color: var(--el-text-color-primary);
  }
}

.number {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;

  @media (max-width: 1366px) {
    grid-template-columns: 1fr 1fr;
    gap: 15px;
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
}

.number-item {
  padding: 21px 20px;

  .top {
    display: grid;
    justify-content: space-between;
    align-content: center;
    grid-template-columns: auto auto;
  }

  .left {
    display: grid;
    gap: 8px;
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
    padding: 14px;
    border-radius: 8px;
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
  }

  .desc {
    padding-top: 12px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.panel {
  padding: 16px;
}

.panel-title {
  font-size: 18px;
  font-weight: 500;
  padding-bottom: 14px;
}

.repair-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
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
</style>
