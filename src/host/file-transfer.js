// Chunked, checksummed file transfer helper shared by the Fleet RPC host and
// the fleet_upload/fleet_download client tools. Writes are gated by the target
// device's Tool Policy (`write` capability) before reaching this module.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024
export const TRANSFER_CHUNK_BYTES = 512 * 1024

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'bad-request' })
}

function requirePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw badRequest('path is required')
  return path.resolve(filePath)
}

export function sha256File(filePath) {
  const target = requirePath(filePath)
  const hash = createHash('sha256')
  const fd = fs.openSync(target, 'r')
  try {
    const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES)
    let offset = 0
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('base64url')
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('base64url')
}

/** Append (offset 0 truncates) one base64 chunk; the final chunk verifies the hash. */
export function writeTransferChunk({ filePath, data = '', offset = 0, final = false, expectedSha256 = null } = {}) {
  const target = requirePath(filePath)
  const chunk = Buffer.from(String(data ?? ''), 'base64')
  if (chunk.length > TRANSFER_CHUNK_BYTES) throw badRequest('upload chunk exceeds the 512 KiB limit')
  const start = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0
  if (start === 0) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, chunk)
  } else {
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw badRequest('upload chunk arrived before the first chunk')
    }
    if (!stat.isFile() || start > stat.size) throw badRequest('upload chunk offset is invalid')
    const fd = fs.openSync(target, 'r+')
    try {
      fs.writeSync(fd, chunk, 0, chunk.length, start)
    } finally {
      fs.closeSync(fd)
    }
  }
  const size = fs.statSync(target).size
  if (size > MAX_TRANSFER_BYTES) {
    fs.rmSync(target, { force: true })
    throw Object.assign(new Error('file exceeds the transfer limit'), { code: 'file-too-large' })
  }
  const result = { filePath: target, offset: start, bytes: chunk.length, size }
  if (final) {
    const sha256 = sha256File(target)
    if (typeof expectedSha256 === 'string' && expectedSha256 !== '' && sha256 !== expectedSha256) {
      fs.rmSync(target, { force: true })
      throw Object.assign(new Error('uploaded file checksum does not match'), { code: 'checksum-mismatch' })
    }
    result.sha256 = sha256
  }
  return result
}

/** Read one bounded base64 chunk (default 512 KiB). */
export function readTransferChunk({ filePath, offset = 0, size = TRANSFER_CHUNK_BYTES } = {}) {  const target = requirePath(filePath)
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    throw Object.assign(new Error('file not found'), { code: 'file-not-found' })
  }
  if (!stat.isFile()) throw badRequest('path is not a file')
  if (stat.size > MAX_TRANSFER_BYTES) throw Object.assign(new Error('file exceeds the transfer limit'), { code: 'file-too-large' })
  const start = Math.min(Math.max(0, Number(offset) || 0), stat.size)
  const length = Math.max(0, Math.min(Math.max(1, Number(size) || TRANSFER_CHUNK_BYTES), TRANSFER_CHUNK_BYTES, stat.size - start))
  const buffer = Buffer.alloc(length)
  if (length > 0) {
    const fd = fs.openSync(target, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, start)
    } finally {
      fs.closeSync(fd)
    }
  }
  const eof = start + length >= stat.size
  return {
    filePath: target,
    offset: start,
    data: buffer.toString('base64'),
    bytes: length,
    size: stat.size,
    eof,
    ...(eof ? { sha256: sha256File(target) } : {}),
  }
}

/** Metadata for one path (used by resume, directory upload and the tools). */
export function statTransferPath({ filePath } = {}) {
  const target = requirePath(filePath)
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    throw Object.assign(new Error('path not found'), { code: 'file-not-found' })
  }
  return {
    path: target,
    name: path.basename(target),
    size: stat.size,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    mtimeMs: stat.mtimeMs,
  }
}

/** Bounded recursive listing; symlinks are reported but never followed. */
export function listTransferTree({ filePath, recursive = false, maxEntries = 2000 } = {}) {
  const root = requirePath(filePath)
  let stat
  try {
    stat = fs.lstatSync(root)
  } catch {
    throw Object.assign(new Error('path not found'), { code: 'file-not-found' })
  }
  const limit = Math.max(1, Math.min(Number(maxEntries) || 2000, 5000))
  const entries = []
  const visit = (dir) => {
    if (entries.length >= limit) return
    for (const name of fs.readdirSync(dir)) {
      if (entries.length >= limit) return
      const full = path.join(dir, name)
      const info = fs.lstatSync(full)
      entries.push({
        path: full,
        relative: path.relative(root, full),
        name,
        size: info.size,
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
        isSymbolicLink: info.isSymbolicLink(),
        mtimeMs: info.mtimeMs,
      })
      if (recursive && info.isDirectory() && !info.isSymbolicLink()) visit(full)
    }
  }
  if (stat.isDirectory()) visit(root)
  return {
    path: root,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    entries,
    truncated: entries.length >= limit,
  }
}

/** Delete one file, or a directory only when `recursive` is true. */
export function deleteTransferPath({ filePath, recursive = false } = {}) {
  const target = requirePath(filePath)
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    throw Object.assign(new Error('path not found'), { code: 'file-not-found' })
  }
  if (stat.isDirectory() && recursive !== true) {
    throw Object.assign(new Error('refusing to delete a directory without recursive: true'), { code: 'bad-request' })
  }
  fs.rmSync(target, { recursive: recursive === true, force: false })
  return { path: target, deleted: true, recursive: recursive === true }
}

/** Enumerate a local tree for directory upload. */
export function localTransferFiles({ root } = {}) {
  const base = requirePath(root)
  const stat = fs.statSync(base)
  if (!stat.isDirectory()) return [{ absolute: base, relative: path.basename(base), size: stat.size }]
  const files = []
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const info = fs.lstatSync(full)
      if (info.isDirectory() && !info.isSymbolicLink()) visit(full)
      else if (info.isFile()) files.push({ absolute: full, relative: path.relative(base, full), size: info.size })
    }
  }
  visit(base)
  return files
}
