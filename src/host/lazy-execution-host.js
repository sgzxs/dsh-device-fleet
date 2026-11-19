// Retry-on-demand resolver for the direct-call execution stack.
//
// Cordis can call the plugin's apply() before sessionController is composed.
// Sampling the service once leaves slot/host null forever, so a remote direct
// call fails with "no execution slot" until a hot reload. This helper retries
// the lookup on each request and builds the stack once the controller exists.
export function createLazyExecutionHost({ getSessionController, build }) {
  if (typeof getSessionController !== 'function') throw new TypeError('getSessionController is required')
  if (typeof build !== 'function') throw new TypeError('build is required')
  let built = null
  return {
    get(context = {}) {
      if (built) return built
      const sessionController = getSessionController()
      if (!sessionController) return null
      built = build(sessionController, context)
      return built
    },
    peek() {
      return built
    },
    reset() {
      built = null
    },
  }
}
