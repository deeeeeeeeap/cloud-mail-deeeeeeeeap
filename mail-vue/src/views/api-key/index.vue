<template>
  <div class="api-key-page">
    <div v-if="loading && first" class="api-key-loading"><Loading/></div>
    <el-scrollbar v-else class="scrollbar">
      <div class="api-key" :aria-busy="loading">
        <div class="api-key-heading">
          <p>{{ $t('apiKeyDesc') }}</p>
          <div class="heading-actions">
            <el-button :loading="loading" @click="refresh">{{ $t('refreshList') }}</el-button>
            <el-button type="primary" :disabled="data.list.length >= data.maxKeys" @click="openAdd">{{ $t('apiKeyAdd') }}</el-button>
          </div>
        </div>
        <el-alert v-if="loadFailed" :title="$t('listLoadFailed')" type="error" :closable="false" show-icon/>

        <section class="panel overview">
          <div class="overview-item endpoint">
            <span class="overview-label">{{ $t('apiKeyEndpoint') }}</span>
            <span class="overview-value mono">
              <span class="ellipsis">{{ endpoint }}</span>
              <button type="button" class="inline-icon" :aria-label="$t('copy')" :title="$t('copy')" @click="copy(endpoint)">
                <Icon aria-hidden="true" icon="cloud-mail:copy" width="16" height="16"/>
              </button>
            </span>
          </div>
          <div class="overview-item">
            <span class="overview-label">{{ $t('apiKeyPublicLimit') }}</span>
            <span class="overview-value">{{ publicLimitText }}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">{{ $t('apiKeyLegacyToken') }}</span>
            <span class="overview-value">
              <template v-if="data.legacyTokenActive">
                <el-tag type="warning" size="small">{{ $t('apiKeyLegacyActive') }}</el-tag>
                <el-button link type="danger" size="small" @click="revokeLegacy">{{ $t('apiKeyLegacyRevoke') }}</el-button>
              </template>
              <span v-else class="muted">{{ $t('apiKeyLegacyInactive') }}</span>
            </span>
          </div>
        </section>

        <div v-if="data.list.length" class="key-grid">
          <article v-for="item in data.list" :key="item.keyId" class="panel key-card" :class="'is-' + keyState(item)">
            <header class="key-head">
              <span class="key-mark"><Icon aria-hidden="true" icon="cloud-mail:key" width="20" height="20"/></span>
              <div class="key-title">
                <h2 :title="item.name">{{ item.name }}</h2>
                <span class="key-prefix mono">{{ item.keyPrefix }}…</span>
              </div>
              <el-tag size="small" :type="stateTagType(item)">{{ $t(stateLabel(item)) }}</el-tag>
              <el-dropdown trigger="click">
                <button type="button" class="inline-icon" :aria-label="$t('apiKeyActions')" :title="$t('apiKeyActions')">
                  <Icon aria-hidden="true" icon="cloud-mail:more" width="20" height="20"/>
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="openEdit(item)">{{ $t('apiKeyEdit') }}</el-dropdown-item>
                    <el-dropdown-item @click="toggleStatus(item)">{{ item.status === 0 ? $t('apiKeyDisable') : $t('enable') }}</el-dropdown-item>
                    <el-dropdown-item @click="rotate(item)">{{ $t('apiKeyRotate') }}</el-dropdown-item>
                    <el-dropdown-item divided @click="remove(item)">{{ $t('delete') }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </header>
            <dl class="key-meta">
              <div>
                <dt>{{ $t('apiKeyScopes') }}</dt>
                <dd class="tags">
                  <el-tag v-for="scope in item.scopes" :key="scope" size="small" effect="plain">{{ $t(scopeLabels[scope]) }}</el-tag>
                </dd>
              </div>
              <div>
                <dt>{{ $t('apiKeySenders') }}</dt>
                <dd :title="item.allowedSenders.join(', ')">{{ item.allowedSenders.length ? item.allowedSenders.join(', ') : $t('apiKeySendersAll') }}</dd>
              </div>
              <div>
                <dt>{{ $t('apiKeyLimits') }}</dt>
                <dd>{{ $t('apiKeyLimitValue', {hour: limitText(item.hourlyLimit), day: limitText(item.dailyLimit)}) }}</dd>
              </div>
              <div>
                <dt>{{ $t('apiKeyUsage') }}</dt>
                <dd class="numeric">{{ $t('apiKeyUsageValue', item.usage) }}</dd>
              </div>
              <div>
                <dt>{{ $t('apiKeyExpiry') }}</dt>
                <dd>{{ item.expiresAt ? formatShortDateTime(item.expiresAt) : $t('apiKeyNeverExpire') }}</dd>
              </div>
              <div>
                <dt>{{ $t('apiKeyLastUsed') }}</dt>
                <dd>{{ item.lastUsedAt ? formatShortDateTime(item.lastUsedAt) : $t('apiKeyNeverUsed') }}</dd>
              </div>
            </dl>
          </article>
        </div>
        <section v-else-if="!loadFailed" class="panel empty">
          <el-empty :image-size="96" :description="$t('apiKeyEmpty')">
            <p class="panel-desc">{{ $t('apiKeyEmptyDesc') }}</p>
            <el-button type="primary" @click="openAdd">{{ $t('apiKeyAdd') }}</el-button>
          </el-empty>
        </section>

        <section class="panel examples">
          <div class="examples-head">
            <h2>{{ $t('apiKeyExamples') }}</h2>
            <el-segmented v-model="exampleLang" :options="exampleOptions" size="small"/>
          </div>
          <p class="panel-desc">{{ $t('apiKeyExampleTip') }}</p>
          <div class="code-block">
            <button type="button" class="inline-icon copy-code" :aria-label="$t('apiKeyCopyExample')" :title="$t('apiKeyCopyExample')" @click="copy(examples[exampleLang])">
              <Icon aria-hidden="true" icon="cloud-mail:copy" width="16" height="16"/>
            </button>
            <pre><code>{{ examples[exampleLang] }}</code></pre>
          </div>
        </section>
      </div>
    </el-scrollbar>

    <el-dialog v-model="showForm" :title="form.keyId ? $t('apiKeyEdit') : $t('apiKeyAdd')" class="api-key-dialog" append-to-body>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item :label="$t('apiKeyName')">
          <el-input v-model="form.name" maxlength="64" :placeholder="$t('apiKeyNamePlaceholder')"/>
        </el-form-item>
        <el-form-item :label="$t('apiKeyScopes')">
          <el-checkbox-group v-model="form.scopes">
            <el-checkbox v-for="scope in API_KEY_SCOPES" :key="scope" :value="scope">{{ $t(scopeLabels[scope]) }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item :label="$t('apiKeySenders')">
          <el-select v-model="form.allowedSenders" multiple filterable allow-create default-first-option
                     :reserve-keyword="false" :placeholder="$t('apiKeySendersPlaceholder')">
            <el-option v-for="option in senderOptions" :key="option" :label="option" :value="option"/>
          </el-select>
          <span class="form-hint">{{ $t('apiKeySendersHint') }}</span>
        </el-form-item>
        <div class="limit-row">
          <el-form-item :label="$t('apiKeyHourlyLimit')">
            <el-input-number v-model="form.hourlyLimit" :min="0" :max="1000000" :step="10" controls-position="right"/>
          </el-form-item>
          <el-form-item :label="$t('apiKeyDailyLimit')">
            <el-input-number v-model="form.dailyLimit" :min="0" :max="1000000" :step="100" controls-position="right"/>
          </el-form-item>
        </div>
        <span class="form-hint limit-hint">{{ $t('apiKeyLimitHint') }}</span>
        <el-form-item :label="$t('apiKeyExpiry')">
          <div class="expiry-row">
            <el-select v-model="form.expiryPreset" @change="form.expiryDirty = true">
              <el-option v-for="preset in EXPIRY_PRESETS" :key="preset" :label="expiryLabel(preset)" :value="preset"/>
            </el-select>
            <el-date-picker v-if="form.expiryPreset === 'custom'" v-model="form.expiryDate" type="date"
                            :disabled-date="isPastDate" :placeholder="$t('apiKeyExpiryDate')" @change="form.expiryDirty = true"/>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showForm = false">{{ $t('cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ form.keyId ? $t('save') : $t('apiKeyAdd') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showSecret" :title="$t('apiKeySecretTitle')" class="api-key-dialog" append-to-body
               :close-on-click-modal="false" :close-on-press-escape="false">
      <el-alert type="warning" :closable="false" show-icon :title="$t('apiKeySecretDesc')"/>
      <div class="secret-box mono">{{ secret.key }}</div>
      <div class="secret-actions">
        <el-button type="primary" @click="copy(secret.key)">{{ $t('apiKeyCopyKey') }}</el-button>
        <el-button @click="copy(secretExample)">{{ $t('apiKeyCopyExample') }}</el-button>
      </div>
      <div class="code-block compact"><pre><code>{{ secretExample }}</code></pre></div>
      <template #footer>
        <el-button type="primary" @click="closeSecret">{{ $t('apiKeySecretSaved') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import {computed, defineOptions, reactive, ref} from 'vue'
import {Icon} from '@iconify/vue/offline'
import {useI18n} from 'vue-i18n'
import Loading from '@/components/loading/index.vue'
import {useSettingStore} from '@/store/setting.js'
import {formatShortDateTime} from '@/utils/day.js'
import {apiKeyAdd, apiKeyDelete, apiKeyList, apiKeyRevokeLegacy, apiKeyRotate, apiKeySet} from '@/request/api-key.js'
import {
  API_KEY_SCOPES,
  EXAMPLE_LANGUAGES,
  EXPIRY_PRESETS,
  buildSendExamples,
  exampleSender,
  keyState,
  resolveExpiresAt,
  senderSuggestions
} from './api-key-helpers.js'

defineOptions({
  name: 'api-key'
})

const {t} = useI18n()
const settingStore = useSettingStore()
const loading = ref(true)
const first = ref(true)
const loadFailed = ref(false)
const saving = ref(false)
const showForm = ref(false)
const showSecret = ref(false)
const exampleLang = ref('curl')
const data = reactive({list: [], legacyTokenActive: false, publicHourlyLimit: 100, publicHourlyUsed: 0, maxKeys: 50})
const secret = reactive({key: '', allowedSenders: []})
const form = reactive(emptyForm())

const scopeLabels = {send: 'apiKeyScopeSend', read: 'apiKeyScopeRead', users: 'apiKeyScopeUsers'}
const exampleLabels = {curl: 'cURL', python: 'Python', node: 'Node.js', powershell: 'PowerShell'}
const exampleOptions = EXAMPLE_LANGUAGES.map(value => ({value, label: exampleLabels[value]}))

const origin = window.location.origin
const endpoint = `${origin}/api/public/sendEmail`
const domainList = computed(() => settingStore.domainList || [])
const senderOptions = computed(() => senderSuggestions(domainList.value, form.allowedSenders))
const examples = computed(() => buildSendExamples({origin, sender: exampleSender([], domainList.value)}))
const secretExample = computed(() => buildSendExamples({
  origin,
  key: secret.key,
  sender: exampleSender(secret.allowedSenders, domainList.value)
}).curl)
const publicLimitText = computed(() => data.publicHourlyLimit > 0
    ? t('apiKeyPublicLimitValue', {used: data.publicHourlyUsed, limit: data.publicHourlyLimit})
    : t('unlimited'))

function emptyForm() {
  return {
    keyId: null,
    name: '',
    scopes: ['send'],
    allowedSenders: [],
    hourlyLimit: 0,
    dailyLimit: 0,
    expiryPreset: 'never',
    expiryDate: null,
    expiryDirty: true
  }
}

async function refresh() {
  loading.value = true
  loadFailed.value = false
  try {
    Object.assign(data, await apiKeyList())
  } catch {
    loadFailed.value = true
  } finally {
    first.value = false
    loading.value = false
  }
}

function stateLabel(item) {
  return {active: 'apiKeyActiveTag', disabled: 'apiKeyDisabledTag', expired: 'apiKeyExpiredTag'}[keyState(item)]
}

function stateTagType(item) {
  return {active: 'success', disabled: 'info', expired: 'danger'}[keyState(item)]
}

function limitText(value) {
  return value > 0 ? value : t('apiKeyUnlimited')
}

function expiryLabel(preset) {
  if (preset === 'never') return t('apiKeyNeverExpire')
  if (preset === 'custom') return t('apiKeyExpireCustom')
  return t('apiKeyExpireDays', {n: preset})
}

function isPastDate(date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return date < today
}

function openAdd() {
  Object.assign(form, emptyForm())
  showForm.value = true
}

function openEdit(item) {
  Object.assign(form, {
    keyId: item.keyId,
    name: item.name,
    scopes: [...item.scopes],
    allowedSenders: [...item.allowedSenders],
    hourlyLimit: item.hourlyLimit,
    dailyLimit: item.dailyLimit,
    expiryPreset: item.expiresAt ? 'custom' : 'never',
    expiryDate: item.expiresAt ? new Date(item.expiresAt) : null,
    expiryDirty: false
  })
  showForm.value = true
}

function buildPayload() {
  const name = form.name.trim()
  if (!name) {
    ElMessage({message: t('apiKeyNameRequired'), type: 'error', plain: true})
    return null
  }
  if (form.scopes.length === 0) {
    ElMessage({message: t('apiKeyScopeRequired'), type: 'error', plain: true})
    return null
  }
  const payload = {
    name,
    scopes: [...form.scopes],
    allowedSenders: form.allowedSenders.map(item => item.trim()).filter(Boolean),
    hourlyLimit: form.hourlyLimit || 0,
    dailyLimit: form.dailyLimit || 0
  }
  if (form.expiryDirty) {
    const expiresAt = resolveExpiresAt(form.expiryPreset, form.expiryDate)
    if (expiresAt === undefined) {
      ElMessage({message: t('apiKeyExpiryRequired'), type: 'error', plain: true})
      return null
    }
    payload.expiresAt = expiresAt
  }
  return payload
}

async function submit() {
  const payload = buildPayload()
  if (!payload || saving.value) return
  saving.value = true
  try {
    if (form.keyId) {
      await apiKeySet({keyId: form.keyId, ...payload})
      ElMessage({message: t('saveSuccessMsg'), type: 'success', plain: true})
    } else {
      revealSecret(await apiKeyAdd(payload))
    }
    showForm.value = false
    await refresh()
  } catch {
    // The API interceptor already shows the server message.
  } finally {
    saving.value = false
  }
}

function revealSecret(record) {
  secret.key = record.key
  secret.allowedSenders = record.allowedSenders || []
  showSecret.value = true
}

function closeSecret() {
  showSecret.value = false
  secret.key = ''
}

async function toggleStatus(item) {
  try {
    await apiKeySet({keyId: item.keyId, status: item.status === 0 ? 1 : 0})
    ElMessage({message: t('setSuccess'), type: 'success', plain: true})
    await refresh()
  } catch {
    // Already reported by the interceptor.
  }
}

async function rotate(item) {
  try {
    await ElMessageBox.confirm(t('apiKeyRotateConfirm', {name: item.name}), t('apiKeyRotate'), {
      type: 'warning',
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel')
    })
  } catch {
    return
  }
  try {
    revealSecret(await apiKeyRotate(item.keyId))
    await refresh()
  } catch {
    // Already reported by the interceptor.
  }
}

async function remove(item) {
  try {
    await ElMessageBox.confirm(t('apiKeyDeleteConfirm', {name: item.name}), t('delete'), {
      type: 'warning',
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel')
    })
  } catch {
    return
  }
  try {
    await apiKeyDelete(item.keyId)
    ElMessage({message: t('delSuccessMsg'), type: 'success', plain: true})
    await refresh()
  } catch {
    // Already reported by the interceptor.
  }
}

async function revokeLegacy() {
  try {
    await ElMessageBox.confirm(t('apiKeyLegacyRevokeConfirm'), t('apiKeyLegacyRevoke'), {
      type: 'warning',
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel')
    })
  } catch {
    return
  }
  try {
    await apiKeyRevokeLegacy()
    await refresh()
  } catch {
    // Already reported by the interceptor.
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
  } catch {
    ElMessage({message: t('copyFailMsg'), type: 'error', plain: true})
  }
}

refresh()
</script>

<style scoped lang="scss">
.api-key-page { height: 100%; }
.api-key-loading { height: 100%; display: grid; place-items: center; }
.scrollbar { height: 100%; background: var(--extra-light-fill); }
.api-key { max-width: 1440px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
.api-key-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.api-key-heading p, .panel-desc { color: var(--secondary-text-color); font-size: 13px; line-height: 1.65; }
.heading-actions { display: flex; gap: 8px; flex-shrink: 0; }
.heading-actions .el-button { margin: 0; }
.panel { min-width: 0; padding: 20px 24px; border: 1px solid var(--el-border-color-light); border-radius: var(--radius-lg); background: var(--el-bg-color); box-shadow: var(--shadow-card); }
h2 { font-size: 15px; font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.muted { color: var(--secondary-text-color); }
.ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.overview { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px 24px; }
.overview-item { display: grid; gap: 6px; min-width: 0; }
.overview-label { font-size: 12px; color: var(--secondary-text-color); }
.overview-value { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-variant-numeric: tabular-nums; }

.inline-icon {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--secondary-text-color);
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
  &:hover { color: var(--el-color-primary); background: var(--light-fill); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
}

.key-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }
.key-card { display: grid; gap: 16px; align-content: start; transition: opacity var(--transition-fast); }
.key-card.is-disabled, .key-card.is-expired { opacity: .72; }
.key-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.key-mark { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 12px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.key-title { flex: 1; min-width: 0; display: grid; gap: 2px; }
.key-title h2 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-prefix { font-size: 12px; color: var(--secondary-text-color); }
.key-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }
.key-meta dt { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px; }
.key-meta dd { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-meta dd.tags { display: flex; flex-wrap: wrap; gap: 4px; white-space: normal; }
.numeric { font-variant-numeric: tabular-nums; }

.empty { display: grid; place-items: center; text-align: center; }
.empty .panel-desc { max-width: 420px; margin: 0 auto 16px; }

.examples { display: grid; gap: 12px; }
.examples-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.code-block { position: relative; min-width: 0; border-radius: var(--radius-md); background: var(--extra-light-fill); border: 1px solid var(--el-border-color-lighter); }
.code-block pre { margin: 0; padding: 14px 48px 14px 16px; overflow-x: auto; font-size: 12px; line-height: 1.6; color: var(--regular-text-color); }
.code-block code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; white-space: pre; }
.code-block.compact pre { padding-right: 16px; max-height: 220px; }
.copy-code { position: absolute; top: 8px; right: 8px; background: var(--el-bg-color); }

.form-hint { display: block; width: 100%; margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--secondary-text-color); }
.limit-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.limit-row .el-input-number { width: 100%; }
.limit-hint { margin: -10px 0 18px; }
.expiry-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; width: 100%; }
.expiry-row :deep(.el-date-editor) { width: 100%; }
.secret-box { margin: 16px 0 12px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--extra-light-fill); border: 1px dashed var(--el-border-color); font-size: 13px; overflow-wrap: anywhere; user-select: all; }
.secret-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.secret-actions .el-button { margin: 0; }

@media (max-width: 1100px) {
  .overview { grid-template-columns: 1fr 1fr; }
  .overview .endpoint { grid-column: 1 / -1; }
}
@media (max-width: 600px) {
  .api-key { padding: 16px; gap: 16px; }
  .api-key-heading { flex-direction: column; align-items: stretch; gap: 12px; }
  .heading-actions .el-button { flex: 1; }
  .panel { padding: 16px; }
  .overview { grid-template-columns: 1fr; }
  .key-grid { grid-template-columns: 1fr; gap: 16px; }
  .key-meta { grid-template-columns: 1fr; }
  .limit-row, .expiry-row { grid-template-columns: 1fr; gap: 0 12px; }
  .expiry-row { gap: 12px; }
}
</style>

<style lang="scss">
.api-key-dialog.el-dialog {
  width: 520px;
  max-width: calc(100% - 32px);
}
</style>
