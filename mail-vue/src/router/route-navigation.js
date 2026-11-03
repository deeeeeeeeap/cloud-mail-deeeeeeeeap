export function resolveRouteNavigation({ token, sessionReady, toName, fromPath, setupRequired }) {
  if (setupRequired) {
    return toName === 'setup'
      ? { type: 'allow' }
      : { type: 'redirect', to: { name: 'setup' } }
  }

  if (toName === 'setup') {
    return {
      type: 'redirect',
      to: token && sessionReady ? { name: 'layout' } : { name: 'login' }
    }
  }

  if ((!token || !sessionReady) && toName !== 'login') {
    return { type: 'redirect', to: { name: 'login' } }
  }

  if (token && sessionReady && toName === 'login') {
    return { type: 'redirect', to: fromPath }
  }

  return { type: 'allow' }
}
