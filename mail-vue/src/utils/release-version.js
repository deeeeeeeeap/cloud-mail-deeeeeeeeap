// GitHub's /releases/latest represents a stable release. Ignore malformed,
// legacy two-part and prerelease tags rather than displaying a false update.
function stableParts(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim())
  return match ? match.slice(1, 4).map(part => BigInt(part)) : null
}

export function isNewerStableRelease(latest, current) {
  const candidate = stableParts(latest)
  const installed = stableParts(current)
  if (!candidate || !installed) return false
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== installed[index]) return candidate[index] > installed[index]
  }
  return false
}
