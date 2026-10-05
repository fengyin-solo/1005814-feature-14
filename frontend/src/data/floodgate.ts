// 闸门调度的专属数据：开度口径与操作留痕。和调度记录一样落在 localStorage，
// 但走独立的存储键，清掉 `drainage-pump:entries` 不会把口径和留痕一起冲掉。
const RULES_KEY = 'drainage-pump:gate-rules'
const AUDIT_KEY = 'drainage-pump:gate-audit'

// 开度口径：按「闸门名称 + 所属河渠」分别设上下限，水位差阈值也挂在这里。
export type GateRule = {
  id: number
  闸门名称: string
  所属河渠: string
  开度下限: number
  开度上限: number
  水位差阈值: number
  更新人: string
  更新时间: string
}

// 操作留痕：谁在什么时候对哪一单改了什么，开度改动必留一条。
export type GateAudit = {
  id: number
  时间: string
  操作人: string
  调度编号: string
  闸门名称: string
  动作: string
  旧开度: string
  新开度: string
  说明: string
}

export const SEED_GATE_RULES: GateRule[] = [
  {
    id: 1,
    闸门名称: '东湖进水闸',
    所属河渠: '东湖渠',
    开度下限: 0.5,
    开度上限: 3.0,
    水位差阈值: 1.0,
    更新人: '系统初始化',
    更新时间: '2026-09-01 08:00:00',
  },
  {
    id: 2,
    闸门名称: '西排涝闸',
    所属河渠: '西排渠',
    开度下限: 1.0,
    开度上限: 4.0,
    水位差阈值: 0.8,
    更新人: '系统初始化',
    更新时间: '2026-09-01 08:00:00',
  },
  {
    id: 3,
    闸门名称: '南湖节制闸',
    所属河渠: '南湖渠',
    开度下限: 0.3,
    开度上限: 2.5,
    水位差阈值: 1.2,
    更新人: '系统初始化',
    更新时间: '2026-09-01 08:00:00',
  },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function read<T>(key: string, fallback: T[]): T[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T[]
  } catch {
    return clone(fallback)
  }
}

function write<T>(key: string, rows: T[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(rows))
  }
}

// 口径与留痕不挂缓存，每次都读最新的：两个标签页同时操作时才能看到对方写的结果。
export function listGateRules(): GateRule[] {
  return read(RULES_KEY, SEED_GATE_RULES)
}

export function saveGateRules(rules: GateRule[]): void {
  write(RULES_KEY, rules)
}

export function listGateAudit(): GateAudit[] {
  return read<GateAudit>(AUDIT_KEY, []).sort((a, b) => b.id - a.id)
}

export function appendGateAudit(entry: Omit<GateAudit, 'id'>): void {
  const rows = read<GateAudit>(AUDIT_KEY, [])
  const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  write(AUDIT_KEY, [...rows, { ...entry, id }])
}
