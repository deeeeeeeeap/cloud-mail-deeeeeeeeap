export function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// 页面在后台时挂起轮询，回到前台立即恢复
export function waitUntilVisible() {
	if (typeof document === 'undefined' || !document.hidden) {
		return Promise.resolve()
	}
	return new Promise(resolve => {
		const onVisible = () => {
			if (!document.hidden) {
				document.removeEventListener('visibilitychange', onVisible)
				resolve()
			}
		}
		document.addEventListener('visibilitychange', onVisible)
	})
}
