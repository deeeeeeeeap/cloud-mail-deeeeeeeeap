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

// Anonymous GitHub API calls are limited to 60 per hour per IP, so a tab reuses
// its last answer (including "no release yet") for six hours.
const RELEASE_CACHE_KEY = 'latest-release-check'
const RELEASE_CACHE_TTL = 6 * 60 * 60 * 1000

export function readCachedRelease(storage = sessionStorage, now = Date.now()) {
  try {
    const cached = JSON.parse(storage.getItem(RELEASE_CACHE_KEY))
    if (cached && now - cached.checkedAt < RELEASE_CACHE_TTL) return cached
  } catch {
    // Disabled or malformed storage behaves like a cache miss.
  }
  return null
}

export function writeCachedRelease(latest, storage = sessionStorage, now = Date.now()) {
  try {
    storage.setItem(RELEASE_CACHE_KEY, JSON.stringify({latest: latest ?? null, checkedAt: now}))
  } catch {
    // Full or disabled storage only means the next visit asks GitHub again.
  }
}
