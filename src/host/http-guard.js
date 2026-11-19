// Browser-origin guard for the local Fleet HTTP surface.
//
// DSH serves the console on loopback. Requests from curl/tests have no Origin
// and remain allowed. Browser requests must be same-origin and loopback-hosted;
// this blocks cross-site form/fetch side effects and DNS-rebinding attempts.
function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function isUnsafeBrowserRequest(req) {
  const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin : ''
  if (origin === '') return false
  const fetchSite = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'cross-site') return true
  try {
    const originUrl = new URL(origin)
    const hostUrl = new URL(`http://${String(req?.headers?.host ?? '')}`)
    if (!isLoopbackHostname(originUrl.hostname) || !isLoopbackHostname(hostUrl.hostname)) return true
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return true
    return originUrl.host !== hostUrl.host
  } catch {
    return true
  }
}
