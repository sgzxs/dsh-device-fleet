// Repair a DSH session log that contains legacy `room/*` events.
//
// Before the plugin-record fix, RoomService wrote Room events with
// `session.append('room/created', ...)`. Those types are outside the harness's
// event vocabulary and carry no `ignorable` marker, so the persistence reader
// refuses the whole log:
//
//   session "..." contains event type "room/created" (seq 3568) unknown to this
//   harness and not marked ignorable; refusing to interpret the log
//
// This tool rewrites each such event into the documented plugin-record shape
// (`plugin:device-fleet/room-created` + `ignorable: true`), preserves every
// other line byte-for-byte, backs up the original, and verifies the result.
//
// Framing matters: DSH reads a session's header by decoding ONLY the first
// zstd frame and requires it to contain exactly one line. A log rewritten as a
// single frame therefore looks header-less and the session silently disappears
// from the sidebar. This tool keeps frame 1 = header line and compresses the
// remaining lines separately (verified after writing).
//
// Usage:
//   node scripts/repair-session-logs.mjs <sessionDir>            # dry run: report only
//   node scripts/repair-session-logs.mjs <sessionDir> --repair   # rewrite + verify
//   node scripts/repair-session-logs.mjs <sessionsRoot> --all --repair
//
// Requires the `zstd` CLI on PATH or in ZSTD_PATH (multi-frame decoding; Node's
// zstd helpers stop after the first frame of an append-log artifact).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD = process.env.ZSTD_PATH ?? 'zstd'
const LOG = 'session.v4.jsonl.zstd'
const FRAME_BYTES = 4 * 1024 * 1024
const RENAME = {
  'room/created': 'plugin:device-fleet/room-created',
  'room/member': 'plugin:device-fleet/room-member',
  'room/message': 'plugin:device-fleet/room-message',
  'room/task': 'plugin:device-fleet/room-task',
  'room/closed': 'plugin:device-fleet/room-closed',
}

function zstd(args, label) {
  const result = spawnSync(ZSTD, args, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 })
  if (result.error) throw new Error(`${label}: cannot run ${ZSTD}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr?.toString().trim()}`)
  return result.stdout
}

/** Decompress to a temp file: a stdout pipe is unreliable for large append-log artifacts. */
function decompressToFile(logPath, workDir, label) {
  const out = join(workDir, `${label}.jsonl`)
  zstd(['-d', '-f', '-q', '-o', out, logPath], label)
  return out
}

function resolveTargets(argument, all) {
  const stat = statSync(argument)
  if (stat.isFile()) return [argument]
  if (existsSync(join(argument, LOG))) return [join(argument, LOG)]
  if (!all) throw new Error(`${argument} is not a session directory; pass --all to scan a sessions root`)
  const found = []
  for (const entry of readdirSync(argument, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(argument, entry.name, LOG)
    if (existsSync(candidate)) found.push(candidate)
    else {
      // sessions/<workspace>/<session>/session.v4.jsonl.zstd
      let inner
      try {
        inner = readdirSync(join(argument, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of inner) {
        if (!child.isDirectory()) continue
        const nested = join(argument, entry.name, child.name, LOG)
        if (existsSync(nested)) found.push(nested)
      }
    }
  }
  return found
}

/** Temp dir for full decompression; falls back to a workspace dir when %TEMP% is not writable. */
function makeWorkDir() {
  try {
    return mkdtempSync(join(tmpdir(), 'dsh-session-repair-'))
  } catch {
    const root = join(process.cwd(), '.repair-tmp')
    mkdirSync(root, { recursive: true })
    return mkdtempSync(join(root, 'dsh-session-repair-'))
  }
}

function scan(logPath) {
  const dir = makeWorkDir()
  try {
    const jsonlPath = decompressToFile(logPath, dir, basename(logPath))
    const raw = readFileSync(jsonlPath, 'utf8')
    const hadTrailingNewline = raw.endsWith('\n')
    const lines = raw.split('\n')
    if (hadTrailingNewline) lines.pop()
    const counts = new Map()
    let changed = 0
    const out = lines.map((line) => {
      if (line.trim() === '') return line
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return line
      }
      const renamed = RENAME[event.type]
      if (renamed === undefined) return line
      if (event.ignorable === true) {
        counts.set(`${event.type} (already ignorable)`, (counts.get(`${event.type} (already ignorable)`) ?? 0) + 1)
        return line
      }
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
      changed += 1
      return JSON.stringify({ ...event, type: renamed, ignorable: true })
    })
    return { dir, jsonlPath, raw, lines, out, counts, changed, hadTrailingNewline }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

function repair(logPath) {
  const state = scan(logPath)
  const { dir, lines, out, changed, hadTrailingNewline } = state
  try {
    if (changed === 0) return { logPath, changed, counts: Object.fromEntries(state.counts) }
    const repairedJsonl = out.join('\n') + (hadTrailingNewline ? '\n' : '')
    // Frame 1 must be exactly the header line: the persistence header reader
    // decodes only the first frame and refuses a log whose first frame is not
    // one header line. Event lines follow in bounded frames.
    const newline = repairedJsonl.indexOf('\n')
    if (newline < 0) throw new Error('log has no header line')
    const header = repairedJsonl.slice(0, newline + 1)
    const body = repairedJsonl.slice(newline + 1)
    const frames = [zstdCompressSync(Buffer.from(header, 'utf8'))]
    for (let offset = 0; offset < body.length; offset += FRAME_BYTES) {
      frames.push(zstdCompressSync(Buffer.from(body.slice(offset, offset + FRAME_BYTES), 'utf8')))
    }
    const repairedZstd = join(dir, 'repaired.zstd')
    writeFileSync(repairedZstd, Buffer.concat(frames))
    const firstFrame = zstdDecompressSync(frames[0])
    if (!firstFrame.equals(Buffer.from(header, 'utf8'))) throw new Error('first frame is not exactly the header line')

    // Verify: decompress the new artifact to a file and compare line by line.
    const checkJsonl = decompressToFile(repairedZstd, dir, 'check')
    const verify = readFileSync(checkJsonl, 'utf8').split('\n')
    if (hadTrailingNewline) verify.pop()
    if (verify.length !== lines.length) throw new Error('line count changed')
    let diff = 0
    for (let index = 0; index < lines.length; index += 1) {
      if (verify[index] === lines[index]) continue
      const parsed = JSON.parse(verify[index])
      if (parsed.ignorable !== true || !String(parsed.type).startsWith('plugin:device-fleet/')) {
        throw new Error(`unexpected change at line ${index + 2}`)
      }
      diff += 1
    }
    if (diff !== changed) throw new Error(`expected ${changed} changed lines, saw ${diff}`)
    for (const line of verify) {
      if (line.trim() === '') continue
      const event = JSON.parse(line)
      if (RENAME[event.type] !== undefined) throw new Error(`line still carries legacy type ${event.type}`)
    }

    const backup = `${logPath}.bak-room-events-${Date.now()}`
    copyFileSync(logPath, backup)
    copyFileSync(repairedZstd, logPath)
    return { logPath, changed, frames: frames.length, backup, counts: Object.fromEntries(state.counts) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const argument = process.argv[2]
if (!argument) {
  console.error('usage: node scripts/repair-session-logs.mjs <sessionDir|sessionLog|sessionsRoot> [--all] [--repair]')
  process.exit(2)
}
const all = process.argv.includes('--all')
const doRepair = process.argv.includes('--repair')
let failures = 0
for (const logPath of resolveTargets(argument, all)) {
  try {
    if (doRepair) {
      const result = repair(logPath)
      console.log(JSON.stringify({ ...result, mode: 'repair' }))
    } else {
      const state = scan(logPath)
      console.log(JSON.stringify({ logPath, events: state.lines.length - 1, changed: state.changed, counts: Object.fromEntries(state.counts), mode: 'scan' }))
      rmSync(state.dir, { recursive: true, force: true })
    }
  } catch (error) {
    failures += 1
    console.error(`${logPath}: ${error.message}`)
  }
}
if (failures > 0) process.exit(1)
