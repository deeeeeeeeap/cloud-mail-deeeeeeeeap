import axios from 'axios'

function getApiPayload(error) {
  const data = error?.response?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  return Number.isInteger(data.code) ? data : null
}

export function classifyHttpError(error) {
  const status = Number(error?.response?.status ?? error?.status)
  const payload = getApiPayload(error)

  // 取消是我们自己发起的（翻页预取作废、hover 预取失效、切账号），不是故障。
  // CanceledError 没有 response、message 也不含 'Network Error'，落到兜底分支就会
  // 弹出「请求失败，请稍后再试」——刷新时作废后台预取本属正常，用户却看到报错。
  if (axios.isCancel(error)) {
    return { kind: 'canceled', payload: null }
  }

  if (payload?.code === 401 || status === 401) {
    return { kind: 'unauthorized', payload }
  }
  if (payload?.code === 403) {
    return { kind: 'forbidden', payload }
  }
  if (status === 403) {
    return { kind: 'edge-forbidden', payload: null }
  }
  // 501 是旧版业务码；其余 5xx 仅展示 Worker 明确标记的业务错误。
  if (payload?.code >= 400 && payload.code <= 599 && (
    payload.code < 500 || payload.code === 501
    || error.response?.headers?.['x-cloud-mail-error'] === 'business'
  )) {
    return { kind: 'business', payload }
  }
  return { kind: 'other', payload }
}

export function isCurrentSessionResponse(requestGeneration, currentGeneration) {
  return requestGeneration === undefined || requestGeneration === currentGeneration
}
