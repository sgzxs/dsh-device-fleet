// Human-friendly, deterministic names for Rooms/sessions. Backend ids stay in
// tooling and diagnostics; the console shows these names instead.
const ADJECTIVES = [
  '琥珀', '青柠', '月白', '雾蓝', '暖橙', '松绿', '珊瑚', '星灰',
  '绯红', '海盐', '薄暮', '晨雾', '银杏', '苔青', '暮金', '霜白',
]
const NOUNS = [
  '狐狸', '海豚', '山雀', '水獭', '麋鹿', '鲸鱼', '刺猬', '猫头鹰',
  '云杉', '灯塔', '帆船', '岛屿', '星图', '罗盘', '风铃', '纸鸢',
]

function hash(value) {
  let h = 2166136261
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Stable name, e.g. `琥珀狐狸 27`. Same seed always yields the same name. */
export function friendlyName(seed, { suffix = true } = {}) {
  const h = hash(seed)
  const adjective = ADJECTIVES[h % ADJECTIVES.length]
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]
  const number = 10 + ((h >>> 8) % 90)
  return `${adjective}${noun}${suffix ? ` ${number}` : ''}`
}

/** Avoid showing raw ids/`host` in user-facing member labels. */
export function memberDisplayName(member, fallback = '协作者') {
  if (!member) return fallback
  if (member.role === 'host') return '主持人'
  const name = typeof member.name === 'string' ? member.name.trim() : ''
  if (name !== '' && name !== 'host' && !/^session-|^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name)) return name
  return member.kind === 'remote' ? '远程成员' : fallback
}
