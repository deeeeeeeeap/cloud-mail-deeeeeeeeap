const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus']

// 收件箱新邮件轮询的节奏：最近 activeWindowMs 内有过活动（进入收件箱、页面重新可见或获得焦点、
// 用户操作、收到新邮件）时按设置的间隔请求；此后每一轮空结果把间隔翻倍（窗口失焦时翻得更快），
// 最长 maxDelayMs。活动会唤醒正在进行的等待：距上次请求已满基础间隔就立即请求，否则补足基础间隔。
export function createPollBackoff({
  activeWindowMs = 2 * 60 * 1000,
  maxDelayMs = 30 * 1000,
  now = () => Date.now(),
  hasFocus = () => globalThis.document?.hasFocus?.() ?? true,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout
} = {}) {
  let lastActiveAt = now()
  let idleRounds = 0
  let wake = null

  function backedOff() {
    return idleRounds > 0 && now() - lastActiveAt >= activeWindowMs
  }

  function delay(baseMs) {
    if (!backedOff()) return baseMs
    const factor = 2 ** Math.min(idleRounds, 5) * (hasFocus() ? 1 : 2)
    return Math.max(baseMs, Math.min(maxDelayMs, baseMs * factor))
  }

  function wait(baseMs, signal) {
    if (signal?.aborted) return Promise.resolve(false)
    const startedAt = now()
    return new Promise(resolve => {
      let timer = null
      const finish = completed => {
        cancel(timer)
        wake = null
        signal?.removeEventListener('abort', onAbort)
        resolve(completed)
      }
      const onAbort = () => finish(false)
      const arm = () => {
        cancel(timer)
        timer = schedule(() => finish(true), Math.max(0, startedAt + delay(baseMs) - now()))
      }
      wake = arm
      signal?.addEventListener('abort', onAbort, { once: true })
      arm()
    })
  }

  function activity() {
    const wasBackedOff = backedOff()
    lastActiveAt = now()
    idleRounds = 0
    if (wasBackedOff) wake?.()
  }

  return {
    wait,
    activity,
    // 一轮请求结束：收到新邮件算作活动；空结果只在活动窗口过后才计入退避
    settle(newMailCount) {
      if (newMailCount > 0) activity()
      else if (now() - lastActiveAt >= activeWindowMs) idleRounds++
    },
    stats: () => ({ idleRounds, waiting: wake !== null })
  }
}

// 页面变为可见、窗口获得焦点或用户操作时回调，返回取消监听的函数
export function trackUserActivity(callback, {
  window: target = globalThis.window,
  document: doc = globalThis.document
} = {}) {
  const onActivity = () => callback()
  const onVisibilityChange = () => {
    if (!doc.hidden) callback()
  }
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, onActivity, { capture: true, passive: true })
  doc.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, onActivity, { capture: true })
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
