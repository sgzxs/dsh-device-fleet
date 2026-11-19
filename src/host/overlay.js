// Optional overlay network detection (Tailscale / ZeroTier). This does not
// embed a VPN client; it surfaces already-installed overlay addresses so the
// Fleet can use them as direct endpoints when the OS interface is not enough.
import { execFile } from 'node:child_process'

function run(command, args, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) resolve({ ok: false, error: String(error?.message ?? error) })
      else resolve({ ok: true, output: String(stdout ?? '') })
    })
  })
}

export async function detectOverlay({ exec = run, timeoutMs = 2000 } = {}) {
  const overlay = { tailscale: null, zerotier: null, checkedAt: Date.now() }
  const tailscale = await exec('tailscale', ['status', '--json'], { timeoutMs })
  if (tailscale.ok) {
    try {
      const parsed = JSON.parse(tailscale.output)
      const self = parsed?.Self ?? {}
      const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === 'string') : []
      overlay.tailscale = { installed: true, online: self.Online !== false, ips, hostname: self.HostName ?? null }
    } catch {
      overlay.tailscale = { installed: true, online: false, ips: [] }
    }
  } else {
    overlay.tailscale = { installed: false, online: false, ips: [] }
  }
  const zerotier = await exec('zerotier-cli', ['listnetworks', '-j'], { timeoutMs })
  if (zerotier.ok) {
    try {
      const parsed = JSON.parse(zerotier.output)
      const networks = Array.isArray(parsed) ? parsed : []
      const ips = []
      for (const network of networks) {
        for (const address of network?.assignedAddresses ?? []) {
          if (typeof address === 'string' && address !== '') ips.push(address.split('/')[0])
        }
      }
      const status = networks.some((network) => network?.status === 'OK')
      overlay.zerotier = { installed: true, online: status, ips, networks: networks.length }
    } catch {
      overlay.zerotier = { installed: true, online: false, ips: [] }
    }
  } else {
    overlay.zerotier = { installed: false, online: false, ips: [] }
  }
  return overlay
}

export function overlayAddresses(overlay) {
  const addresses = []
  for (const entry of [overlay?.tailscale, overlay?.zerotier]) {
    for (const ip of entry?.ips ?? []) if (!addresses.includes(ip)) addresses.push(ip)
  }
  return addresses
}
