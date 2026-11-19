// Harness compatibility: the Room/Fleet wire protocol is versioned by the
// plugin version and must stay exact. The DSH harness version is a host API
// guard; prerelease builds of the same core version (e.g. 0.2.2-rc.1 vs
// 0.2.2-rc.2) share the release line and are allowed to interoperate.
export function parseHarnessVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    core: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: value.includes('-'),
  }
}

export function harnessVersionsCompatible(localVersion, peerVersion) {
  if (localVersion === peerVersion) return true
  const local = parseHarnessVersion(localVersion)
  const peer = parseHarnessVersion(peerVersion)
  if (!local || !peer) return false
  return local.major === peer.major && local.minor === peer.minor && local.patch === peer.patch
}

export function describeHarnessVersion(value) {
  const parsed = parseHarnessVersion(value)
  return parsed ? parsed.core : String(value ?? 'unknown')
}
