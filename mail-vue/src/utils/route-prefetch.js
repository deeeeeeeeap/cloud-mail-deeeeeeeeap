// 预取路由的懒加载组件 chunk：只触发下载不等待，真正导航时直接命中模块缓存。
// 每个路由只取一次，加载失败后允许下次再试；解析不了的路由静默跳过。
export function createRoutePrefetcher(router) {
  const requested = new Set()
  return function prefetch(name) {
    if (requested.has(name) || !router.hasRoute(name)) return
    requested.add(name)
    try {
      for (const record of router.resolve({ name }).matched) {
        const load = record.components?.default
        if (typeof load === 'function' && !load.prototype) {
          load().catch(() => requested.delete(name))
        }
      }
    } catch {
      requested.delete(name)
    }
  }
}
