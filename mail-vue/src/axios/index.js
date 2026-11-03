import axios from 'axios'
import i18n from '@/i18n/index.js'
import { useSettingStore } from '@/store/setting.js'
import { clearAuthSession, getSessionGeneration } from '@/session/auth-session.js'
import { classifyHttpError, isCurrentSessionResponse } from '@/axios/response-error.js'

const http = axios.create({
  baseURL: import.meta.env.VITE_BASE_URL,
  timeout: 30 * 1000
})

http.interceptors.request.use(config => {
  const { lang } = useSettingStore()
  config.headers.Authorization = `${localStorage.getItem('token')}`
  config.headers['accept-language'] = lang
  config.cloudMailSessionGeneration = getSessionGeneration()
  return config
})

http.interceptors.response.use(async res => {
  const data = res.data
  if (data.code === 200) {
    return data.data
  }

  const currentResponse = isCurrentSessionResponse(
    res.config.cloudMailSessionGeneration,
    getSessionGeneration()
  )
  if (data.code === 401 && currentResponse) {
    if (!res.config.noMsg) showApiMessage(data.message, 'error')
    await clearAuthSession()
  } else if (!res.config.noMsg) {
    showApiMessage(data.message, data.code === 403 ? 'warning' : 'error')
  }
  return Promise.reject(data)
}, async error => {
  const classification = classifyHttpError(error)
  const noMsg = error.config?.noMsg
  const currentResponse = isCurrentSessionResponse(
    error.config?.cloudMailSessionGeneration,
    getSessionGeneration()
  )

  if (classification.kind === 'canceled') {
    return Promise.reject(error)
  }

  if (classification.kind === 'unauthorized') {
    if (currentResponse) {
      if (!noMsg) showApiMessage(classification.payload?.message, 'error')
      await clearAuthSession()
    }
    return Promise.reject(classification.payload || error)
  }

  if (classification.kind === 'forbidden') {
    if (!noMsg) showApiMessage(classification.payload?.message, 'warning')
    return Promise.reject(classification.payload)
  }

  if (classification.kind === 'edge-forbidden') {
    // Only a non-JSON edge/challenge response may trigger the one-shot reload path.
    if (!sessionStorage.getItem('reloaded-on-403')) {
      sessionStorage.setItem('reloaded-on-403', '1')
      location.reload()
    }
    return Promise.reject(error)
  }

  if (classification.kind === 'business') {
    if (!noMsg) showApiMessage(classification.payload.message, 'error')
    return Promise.reject(classification.payload)
  }

  if (noMsg) {
    return Promise.reject(error)
  }
  if (error.message?.includes('Network Error')) {
    showApiMessage(i18n.global.t('networkErrorMsg'), 'error')
  } else if (error.code === 'ECONNABORTED') {
    showApiMessage(i18n.global.t('timeoutErrorMsg'), 'error')
  } else if (error.response) {
    showApiMessage(i18n.global.t('serverBusyErrorMsg'), 'error')
  } else {
    showApiMessage(i18n.global.t('reqFailErrorMsg'), 'error')
  }
  return Promise.reject(error)
})

function showApiMessage(message, type) {
  ElMessage({
    message: message || i18n.global.t('reqFailErrorMsg'),
    type,
    plain: true,
    grouping: true,
    repeatNum: -4
  })
}

export default http
