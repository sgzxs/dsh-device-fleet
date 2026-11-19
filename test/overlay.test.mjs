import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectOverlay, overlayAddresses } from '../src/host/overlay.js'

test('overlay detection parses Tailscale and ZeroTier addresses', async () => {
  const exec = async (command) => {
    if (command === 'tailscale') {
      return {
        ok: true,
        output: JSON.stringify({ Self: { Online: true, HostName: 'a', TailscaleIPs: ['100.64.0.1', 'fd7a:115c::1'] } }),
      }
    }
    if (command === 'zerotier-cli') {
      return {
        ok: true,
        output: JSON.stringify([{ status: 'OK', assignedAddresses: ['10.147.20.5/24', 'fd00::5/64'] }]),
      }
    }
    return { ok: false, error: 'not found' }
  }
  const overlay = await detectOverlay({ exec })
  assert.equal(overlay.tailscale.installed, true)
  assert.equal(overlay.tailscale.online, true)
  assert.deepEqual(overlay.tailscale.ips, ['100.64.0.1', 'fd7a:115c::1'])
  assert.equal(overlay.zerotier.installed, true)
  assert.deepEqual(overlay.zerotier.ips, ['10.147.20.5', 'fd00::5'])
  assert.deepEqual(overlayAddresses(overlay), ['100.64.0.1', 'fd7a:115c::1', '10.147.20.5', 'fd00::5'])
})

test('overlay detection degrades when clients are not installed', async () => {
  const overlay = await detectOverlay({ exec: async () => ({ ok: false, error: 'not found' }) })
  assert.equal(overlay.tailscale.installed, false)
  assert.equal(overlay.zerotier.installed, false)
  assert.deepEqual(overlayAddresses(overlay), [])
})
