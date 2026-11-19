// Plain TCP direct transport: a listening server and an outbound dialer.
// The secure channel runs on top; this module only owns sockets.
import net from 'node:net'

/**
 * Start a direct listener.
 * @param {{host?: string, port?: number}} [options]
 * @returns {{server: net.Server, ready: Promise<{host: string, port: number}>, close: () => Promise<void>}}
 */
export function createDirectServer({ host = '0.0.0.0', port = 0 } = {}) {
  const server = net.createServer({ allowHalfOpen: false })
  // Track inbound sockets so close() can force-disconnect half-open handshakes;
  // otherwise server.close() waits forever on peers that never complete a
  // handshake and a plugin reload can leave the configured port occupied.
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      resolve({ host: typeof address === 'object' && address ? address.address : host, port: address?.port ?? port })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  return {
    server,
    ready,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
        }
        sockets.clear()
        if (!server.listening) return resolve()
        const timer = setTimeout(() => resolve(), 1_000)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
  }
}

/**
 * Dial a direct endpoint.
 * @param {{host: string, port: number, timeoutMs?: number}} options
 * @returns {Promise<import('node:net').Socket>}
 */
export function connectDirect({ host, port, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      const error = new Error(`direct connect to ${host}:${String(port)} timed out`)
      error.code = 'connect-timeout'
      reject(error)
    }, timeoutMs)
    timer.unref?.()
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = () => {
      cleanup()
      resolve(socket)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}
