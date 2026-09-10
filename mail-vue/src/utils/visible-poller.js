// A single abortable polling loop. It never runs in a hidden tab and does not
// overlap requests within one activation. Failures back off; opting out clears it.
export function createVisiblePoller({
  run, document: target = globalThis.document, intervalMs = 10000,
  maxDelayMs = 60000, setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout
}) {
  let enabled = false
  let disposed = false
  let timer = null
  let controller = null
  let epoch = 0
  let delay = intervalMs

  function interrupt() {
    epoch++
    if (timer !== null) cancel(timer)
    timer = null
    controller?.abort()
    controller = null
  }
  async function tick() {
    timer = null
    if (!enabled || disposed || target.hidden) return
    const generation = epoch
    const request = new AbortController()
    controller = request
    let success = false
    try { success = (await run(request.signal)) !== false } catch { /* retry with backoff */ }
    if (generation !== epoch || !enabled || disposed || target.hidden) return
    controller = null
    delay = success ? intervalMs : Math.min(maxDelayMs, delay * 2)
    timer = schedule(tick, delay)
  }
  function visibilityChanged() {
    interrupt()
    if (enabled && !target.hidden) { delay = intervalMs; void tick() }
  }
  target.addEventListener('visibilitychange', visibilityChanged)
  return {
    start() {
      if (enabled || disposed) return
      enabled = true
      delay = intervalMs
      void tick()
    },
    stop() { enabled = false; interrupt() },
    dispose() {
      disposed = true
      enabled = false
      interrupt()
      target.removeEventListener('visibilitychange', visibilityChanged)
    }
  }
}
