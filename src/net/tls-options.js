// Relay TLS material resolution shared by the relay server and its clients.
//
// Configured values may be either an inline PEM string or a filesystem path to
// a PEM file; the latter keeps profile patches readable. Only the client-side
// fields are ever advertised in invites (the CA, the expected server name and
// the rejectUnauthorized override); private keys stay on the relay host.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function readPem(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (value.includes('-----BEGIN')) return value
  return readFileSync(value, 'utf8')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function clientTlsOptions(tls) {
  if (!isPlainObject(tls)) return null
  const options = {}
  if (tls.ca !== undefined && tls.ca !== null && tls.ca !== '') {
    try {
      options.ca = readPem(tls.ca)
    } catch {
      throw Object.assign(new Error('relay TLS CA file cannot be read'), { code: 'bad-tls-config' })
    }
  }
  if (tls.cert !== undefined && tls.cert !== null && tls.cert !== '') {
    try {
      options.cert = readPem(tls.cert)
    } catch {
      throw Object.assign(new Error('relay TLS client certificate file cannot be read'), { code: 'bad-tls-config' })
    }
  }
  if (tls.key !== undefined && tls.key !== null && tls.key !== '') {
    try {
      options.key = readPem(tls.key)
    } catch {
      throw Object.assign(new Error('relay TLS client key file cannot be read'), { code: 'bad-tls-config' })
    }
  }
  if (typeof tls.servername === 'string' && tls.servername !== '') options.servername = tls.servername
  if (tls.rejectUnauthorized === false) options.rejectUnauthorized = false
  return Object.keys(options).length > 0 ? options : null
}

export function serverTlsOptions(tls) {
  if (!isPlainObject(tls) || !tls.cert || !tls.key) return null
  try {
    // A fingerprint allowlist is useless unless the client certificate is
    // actually requested. Enable it automatically when an allowlist is set.
    const hasAllowlist = readClientAllowlist(tls) !== null
    return {
      cert: readPem(tls.cert),
      key: readPem(tls.key),
      ...(tls.ca ? { ca: readPem(tls.ca) } : {}),
      requestCert: tls.requestCert === true || hasAllowlist,
      rejectUnauthorized: tls.rejectUnauthorized === true,
    }
  } catch {
    throw Object.assign(new Error('relay TLS certificate/key file cannot be read'), { code: 'bad-tls-config' })
  }
}

export function isTlsConfigured(tls) {
  try {
    return serverTlsOptions(tls) !== null
  } catch {
    return false
  }
}

/** Normalize a SHA-256 certificate fingerprint to lowercase hex without colons. */
export function normalizeFingerprint(value) {
  return String(value ?? '').replace(/[^a-f0-9]/gi, '').toLowerCase()
}

/** Read the mTLS client allowlist from an inline array or a JSON/text file. */
export function readClientAllowlist(tls) {
  if (!isPlainObject(tls)) return null
  const inline = Array.isArray(tls.allowedClientFingerprints) ? tls.allowedClientFingerprints : null
  const file = typeof tls.allowedClientFingerprintsFile === 'string' && tls.allowedClientFingerprintsFile !== ''
    ? tls.allowedClientFingerprintsFile
    : null
  if (!inline && !file) return null
  let values = inline ?? []
  if (file) {
    try {
      const text = readFileSync(file, 'utf8')
      const parsed = JSON.parse(text)
      const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : Array.isArray(parsed?.clients) ? parsed.clients : []
      values = raw.map((entry) => (typeof entry === 'string' ? entry : entry?.fingerprint))
    } catch {
      // A missing allowlist must fail closed: an empty set rejects every client.
      values = []
    }
  }
  return new Set(values.map(normalizeFingerprint).filter(Boolean))
}

/** SHA-256 fingerprint of the peer certificate, or null when absent. */
export function peerCertificateFingerprint(socket) {
  try {
    const cert = socket?.getPeerCertificate?.(true)
    if (!cert || !cert.raw) return null
    return createHash('sha256').update(cert.raw).digest('hex')
  } catch {
    return null
  }
}
