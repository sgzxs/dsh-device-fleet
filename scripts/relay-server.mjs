// Self-hosted DSH Fleet relay (v2).
//
// Usage:
//   node scripts/relay-server.mjs --host 0.0.0.0 --port 60600 --data-port 60601
//   node scripts/relay-server.mjs --fleet-state C:/Users/me/.dsh/profiles/desktop/device-fleet/fleet.json
//   node scripts/relay-server.mjs --tls-cert relay-cert.pem --tls-key relay-key.pem
//
// The relay only carries end-to-end encrypted frames; it needs the fleetKey to
// authenticate device registrations. Keep this process on a trusted VPS and
// open BOTH the control port and the data port in the firewall. With
// --tls-cert/--tls-key both ports require TLS; devices must configure the same
// CA (relay.tls.ca) in their device-fleet relay settings.
import { readFileSync, watch } from 'node:fs'
import { createRelayServer } from '../src/net/index.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const host = arg('host', '0.0.0.0')
const port = Number(arg('port', '60600'))
const dataPort = Number(arg('data-port', '60601'))
const dataHost = arg('data-host', host)
const fleetStateFile = arg('fleet-state', null)
const fleetsFile = arg('fleets', null)
const tlsCert = arg('tls-cert', null)
const tlsKey = arg('tls-key', null)
const tlsCa = arg('tls-ca', null)
const tlsClientAllowlist = arg('tls-client-allowlist', null)

if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
  console.error('TLS needs both --tls-cert and --tls-key.')
  process.exit(2)
}
const tls = tlsCert
  ? {
      cert: tlsCert,
      key: tlsKey,
      ...(tlsCa ? { ca: tlsCa } : {}),
      ...(tlsClientAllowlist ? { allowedClientFingerprintsFile: tlsClientAllowlist, requestCert: true, rejectUnauthorized: Boolean(tlsCa) } : {}),
    }
  : null

const fleets = {}
if (fleetsFile) {
  Object.assign(fleets, JSON.parse(readFileSync(fleetsFile, 'utf8')))
}
if (fleetStateFile) {
  const state = JSON.parse(readFileSync(fleetStateFile, 'utf8'))
  if (!state.fleetId || !state.fleetKey) throw new Error('fleet state must contain fleetId/fleetKey')
  fleets[state.fleetId] = state.fleetKey
}
if (Object.keys(fleets).length === 0) {
  console.error('No fleet configured. Pass --fleet-state <fleet.json> or --fleets <fleets.json>.')
  process.exit(2)
}

const relay = createRelayServer({ host, port, dataHost, dataPort, fleets, tls })
const { port: controlPort, dataPort: actualDataPort } = await relay.ready
console.log(`[device-fleet relay] listening control=${host}:${controlPort} data=${dataHost}:${actualDataPort} fleets=${Object.keys(fleets).length} tls=${relay.state.secure ? 'on' : 'off'}`)
console.log('[device-fleet relay] set the same host/control/data ports in each device\'s device-fleet relay config.')
if (relay.state.secure && !tlsCa) {
  console.log('[device-fleet relay] self-signed certificate: set relay.tls.ca (or --tls-ca on devices) to the same PEM/CA before connecting.')
}

const shutdown = async () => {
  await relay.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', () => {
  try {
    if (!tlsCert) throw new Error('relay is not running with TLS')
    const result = relay.reloadTls(tls)
    console.log(`[device-fleet relay] TLS reloaded at ${new Date(result.tlsRotatedAt).toISOString()}`)
  } catch (error) {
    console.error(`[device-fleet relay] TLS reload failed: ${String(error?.message ?? error)}`)
  }
})
if (tlsCert) {
  let reloadTimer = null
  const scheduleTlsReload = () => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      try {
        const result = relay.reloadTls(tls)
        console.log(`[device-fleet relay] TLS auto-reloaded at ${new Date(result.tlsRotatedAt).toISOString()}`)
      } catch (error) {
        console.error(`[device-fleet relay] TLS auto-reload failed: ${String(error?.message ?? error)}`)
      }
    }, 500)
    reloadTimer.unref?.()
  }
  for (const file of [tlsCert, tlsKey, tlsCa].filter(Boolean)) {
    try {
      const watcher = watch(file, { persistent: false }, scheduleTlsReload)
      watcher.unref?.()
    } catch {
      /* file watching is best effort; SIGHUP still works */
    }
  }
}
await new Promise(() => {})
