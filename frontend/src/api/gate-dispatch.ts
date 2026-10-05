import { listRows, readJson, reloadCache, saveRows, writeJson } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 闸门调度域：开度口径、状态流转、并发互斥与全程留痕都集中在这里，页面只做渲染。
 *
 * 状态只能沿一条线走：待调度 → 执行中 → 已终止；「已作废」不是线上状态，
 * 是同一道闸、同一时段被更新一版顶下来的旧单的归档态（作废但留痕）。
 */
export const GATE_STATUS = {
  pending: '待调度',
  running: '执行中',
  terminated: '已终止',
  voided: '已作废',
} as const

// 活跃单：只有这两种会参与「同一道闸同一时段唯一」与口径重算。
const ACTIVE_STATUSES: string[] = [GATE_STATUS.pending, GATE_STATUS.running]
// 终止时自动生成的内涝处置单，落在「待处置（待派队）」清单。
const WATERLOG_PENDING = '待处置'

const LIMIT_KEY = 'gate-opening-limits'
const TRACE_KEY = 'gate-traces'
const LOCK_KEY = 'gate-locks'

// 同一道闸的互斥锁只锁一小段时间：演示「先到先得」，又不至于因异常退出把闸永久锁死。
const LOCK_TTL_MS = 20_000

// 域内调度单标记：用来和脚手架自带的占位示例数据区分，首次进入闸门页时迁移一次。
const DOMAIN_TAG = 'gate-domain-v1'

export type OpeningLimit = {
  gate: string
  canal: string
  min: number
  max: number
  /** 上下游水位差超过该值（米）必须先观察一轮再开。 */
  headThreshold: number
  version: number
  updatedAt: string
  updatedBy: string
}

export type GateTrace = {
  id: number
  gate: string
  orderCode: string
  type:
    | '登记'
    | '执行'
    | '终止'
    | '改开度'
    | '观察'
    | '作废'
    | '口径调整'
    | '口径重算'
  detail: string
  operator: string
  at: string
}

type GateLock = {
  gate: string
  operator: string
  at: string
  expiresAt: number
}

export type GateOrderInput = {
  gate: string
  canal: string
  opening: number
  upstream: number
  downstream: number
  period: string
  operator: string
}

export type AdjustInput = {
  id: number
  opening: number
  upstream: number
  downstream: number
  reason: string
  operator: string
  /** 页面上该条记录的版本号；和库里不一致说明已经被别人先动过。 */
  version: number
}

export type TerminateInput = {
  id: number
  upstream: number
  downstream: number
  operator: string
  version: number
}

export type LimitInput = {
  gate: string
  canal: string
  min: number
  max: number
  headThreshold: number
  operator: string
}

// ---------- 基础工具 ----------

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

function readLimits(): OpeningLimit[] {
  return readJson<OpeningLimit[]>(LIMIT_KEY, [])
}

function writeLimits(limits: OpeningLimit[]): void {
  writeJson(LIMIT_KEY, limits)
}

function readTraces(): GateTrace[] {
  return readJson<GateTrace[]>(TRACE_KEY, [])
}

function appendTrace(trace: Omit<GateTrace, 'id' | 'at'>): void {
  const traces = readTraces()
  traces.unshift({ ...trace, id: (traces[0]?.id ?? 0) + 1, at: nowText() })
  writeJson(TRACE_KEY, traces)
}

function readLocks(): GateLock[] {
  const now = Date.now()
  const locks = readJson<GateLock[]>(LOCK_KEY, []).filter((lock) => lock.expiresAt > now)
  writeJson(LOCK_KEY, locks)
  return locks
}

function findLimit(limits: OpeningLimit[], gate: string, canal: string): OpeningLimit | undefined {
  return limits.find(
    (item) => item.gate === gate && (canal === '' || item.canal === canal),
  ) ?? limits.find((item) => item.gate === gate)
}

// 开度口径校验：越界时把「超出了多少」算清楚，随退回原因一起返回。
function checkOpening(limit: OpeningLimit | undefined, gate: string, opening: number): string {
  if (Number.isNaN(opening)) {
    return '闸门开度不是有效数字'
  }
  if (!limit) {
    return `尚未给「${gate}」这道闸设置开度口径上下限，请先在口径管理里配置`
  }
  if (opening < limit.min) {
    return `开度 ${opening}% 低于「${limit.gate}」口径下限 ${limit.min}%，还差 ${(limit.min - opening).toFixed(1)} 个百分点，不许提交`
  }
  if (opening > limit.max) {
    return `开度 ${opening}% 超出「${limit.gate}」口径上限 ${limit.max}%，超出 ${(opening - limit.max).toFixed(1)} 个百分点，不许提交`
  }
  return ''
}

/** 取一道闸当前生效的口径（按 闸门名称 + 所属河渠 匹配）。 */
export function getOpeningLimit(gate: string, canal = ''): OpeningLimit | undefined {
  return findLimit(readLimits(), gate, canal)
}

// ---------- 并发控制：先到先得 + 乐观版本 ----------

/**
 * 同一道闸只认先到的那一次操作：先拿到锁的操作人继续，后来者（即使是另一标签页）
 * 会被挡住并告知是谁在什么时候先动的。同一操作人重复提交视为连续操作，放行。
 */
function acquireGateLock(gate: string, operator: string): ActionResult {
  const locks = readLocks()
  const held = locks.find((lock) => lock.gate === gate)
  if (held && held.operator !== operator) {
    return {
      ok: false,
      message: `「${gate}」正由 ${held.operator} 于 ${held.at} 先操作，同一道闸只认先到的那一次，请等其完成后再试`,
    }
  }
  const next = locks.filter((lock) => lock.gate !== gate)
  next.push({ gate, operator, at: nowText(), expiresAt: Date.now() + LOCK_TTL_MS })
  writeJson(LOCK_KEY, next)
  return { ok: true, message: '' }
}

function releaseGateLock(gate: string, operator: string): void {
  const locks = readJson<GateLock[]>(LOCK_KEY, []).filter(
    (lock) => !(lock.gate === gate && lock.operator === operator),
  )
  writeJson(LOCK_KEY, locks)
}

// 放弃内存缓存直接读最新数据，拿页面手里的版本号比对，挡住并发下的过期写入。
function latestRow(id: number): EntryRow | undefined {
  const rows = reloadCache().floodgate ?? []
  return rows.find((row) => Number(row.id) === id)
}

function checkVersion(row: EntryRow, version: number): string {
  if (Number(row.__version ?? 0) !== version) {
    return `该调度单已被 ${row.__lastBy ?? '其他操作人'} 于 ${row.__lastAt ?? '稍早'} 先改动过，页面为旧版本，请刷新后按最新数据操作`
  }
  return ''
}

function persist(rows: EntryRow[]): void {
  saveRows('floodgate', rows)
}

// ---------- 开度口径管理 ----------

export function listOpeningLimits(): OpeningLimit[] {
  return readLimits().map((item) => ({ ...item }))
}

/**
 * 新增/调整某道闸的开度口径。口径变过之后，同一道闸正在执行（待调度、执行中）
 * 的单子立即按新口径重算：越界的单标口径告警并留痕；回到区间内的解除告警。
 */
export function saveOpeningLimit(input: LimitInput): ActionResult {
  if (!input.gate.trim()) {
    return { ok: false, message: '闸门名称不能为空' }
  }
  if (!(input.min >= 0) || !(input.max <= 100) || input.min >= input.max) {
    return { ok: false, message: '口径需满足 0 ≤ 下限 < 上限 ≤ 100' }
  }
  if (!(input.headThreshold > 0)) {
    return { ok: false, message: '水位差观察阈值必须大于 0' }
  }

  const limits = readLimits()
  const idx = limits.findIndex(
    (item) => item.gate === input.gate.trim() && item.canal === input.canal.trim(),
  )
  const prev = idx >= 0 ? limits[idx] : undefined
  const nextLimit: OpeningLimit = {
    gate: input.gate.trim(),
    canal: input.canal.trim(),
    min: input.min,
    max: input.max,
    headThreshold: input.headThreshold,
    version: (prev?.version ?? 0) + 1,
    updatedAt: nowText(),
    updatedBy: input.operator,
  }
  if (idx >= 0) {
    limits[idx] = nextLimit
  } else {
    limits.push(nextLimit)
  }
  writeLimits(limits)

  appendTrace({
    gate: nextLimit.gate,
    orderCode: '—',
    type: '口径调整',
    detail: prev
      ? `口径 ${prev.min}%~${prev.max}%（水位差阈值 ${prev.headThreshold}m）调整为 ${nextLimit.min}%~${nextLimit.max}%（阈值 ${nextLimit.headThreshold}m）`
      : `新开口度口径 ${nextLimit.min}%~${nextLimit.max}%，水位差超 ${nextLimit.headThreshold}m 须先观察一轮`,
    operator: input.operator,
  })

  const recalc = recalcActiveOrders(nextLimit, input.operator)
  return {
    ok: true,
    message: prev
      ? `「${nextLimit.gate}」口径已更新，并按新口径重算了 ${recalc} 张在执行的单子`
      : `已为「${nextLimit.gate}」设置开度口径`,
  }
}

function recalcActiveOrders(limit: OpeningLimit, operator: string): number {
  const rows = latestRowsAll()
  let touched = 0
  rows.forEach((row) => {
    if (
      row.闸门名称 !== limit.gate ||
      !ACTIVE_STATUSES.includes(String(row.status))
    ) {
      return
    }
    const opening = num(row.闸门开度)
    const out = Number.isNaN(opening) || opening < limit.min || opening > limit.max
    const before = Boolean(row.__alarm)
    row.__alarm = out
    if (out !== before) {
      touched += 1
      appendTrace({
        gate: limit.gate,
        orderCode: String(row.调度编号),
        type: '口径重算',
        detail: out
          ? `按新口径 ${limit.min}%~${limit.max}% 重算，当前开度 ${opening}% 已越界，挂口径告警，退回修正前不得继续执行`
          : `按新口径 ${limit.min}%~${limit.max}% 重算，当前开度 ${opening}% 回到区间，解除口径告警`,
        operator,
      })
    }
  })
  persist(rows)
  return rows.filter(
    (row) => row.闸门名称 === limit.gate && ACTIVE_STATUSES.includes(String(row.status)),
  ).length
}

function latestRowsAll(): EntryRow[] {
  return (reloadCache().floodgate ?? []).map((row) => ({ ...row }))
}

// ---------- 调度单登记 ----------

/**
 * 登记一张调度单（待调度）。
 * - 开度必须落在该闸（名称+河渠）口径区间内，越界退回并写明超出多少；
 * - 同一道闸、同一时段只保留一条活跃单：重复下发按最新一版执行，旧单自动作废但留痕。
 * 水位差超阈值「先观察一轮再开」卡的是开闸（执行）那一步，见 startOrder。
 */
export function createGateOrder(input: GateOrderInput): ActionResult {
  const gate = input.gate.trim()
  const canal = input.canal.trim()
  const period = input.period.trim()
  if (!gate || !canal || !period) {
    return { ok: false, message: '闸门名称、所属河渠、调度时段都不能为空' }
  }
  if (Number.isNaN(input.upstream) || Number.isNaN(input.downstream)) {
    return { ok: false, message: '上、下游水位必须是有效数字' }
  }

  const locked = acquireGateLock(gate, input.operator)
  if (!locked.ok) {
    return locked
  }

  const limits = readLimits()
  const limit = findLimit(limits, gate, canal)
  const openingError = checkOpening(limit, gate, input.opening)
  if (openingError) {
    releaseGateLock(gate, input.operator)
    return { ok: false, message: openingError }
  }

  const head = +(Math.abs(input.upstream - input.downstream)).toFixed(2)
  const rows = latestRowsAll()
  const sameSlot = rows.find(
    (row) =>
      row.闸门名称 === gate &&
      String(row.调度时段) === period &&
      ACTIVE_STATUSES.includes(String(row.status)),
  )

  const code = nextOrderCode(rows)
  const stamp = nowText()
  const order: EntryRow = {
    id: nextId(),
    status: GATE_STATUS.pending,
    pending: true,
    abnormal: false,
    调度编号: code,
    闸门名称: gate,
    所属河渠: canal,
    调度时段: period,
    闸门开度: input.opening,
    上游水位: input.upstream,
    下游水位: input.downstream,
    水位差: head,
    调度人: input.operator,
    登记时间: stamp,
    __domain: DOMAIN_TAG,
    __version: 1,
    __observeRounds: 0,
    __alarm: false,
    __lastBy: input.operator,
    __lastAt: stamp,
  }
  rows.push(order)

  // 重复下发：同一道闸同一时段已有的活跃单自动作废，记录被哪一版顶掉。
  if (sameSlot) {
    sameSlot.status = GATE_STATUS.voided
    sameSlot.pending = false
    sameSlot.abnormal = true
    sameSlot.__supersededBy = code
    sameSlot.__lastBy = input.operator
    sameSlot.__lastAt = stamp
    sameSlot.__version = Number(sameSlot.__version ?? 1) + 1
    appendTrace({
      gate,
      orderCode: String(sameSlot.调度编号),
      type: '作废',
      detail: `同一道闸同一时段重复下发，按最新一版 ${code} 执行，本单自动作废（留痕）`,
      operator: input.operator,
    })
  }

  appendTrace({
    gate,
    orderCode: code,
    type: '登记',
    detail: `登记调度单，开度 ${input.opening}%（口径 ${limit!.min}%~${limit!.max}%），上/下游水位 ${input.upstream}/${input.downstream}m，水位差 ${head}m，时段 ${period}${
      sameSlot ? `；顶换旧单 ${sameSlot.调度编号}` : ''
    }`,
    operator: input.operator,
  })

  persist(rows)
  releaseGateLock(gate, input.operator)
  return {
    ok: true,
    message: sameSlot
      ? `${code} 已登记，旧单 ${sameSlot.调度编号} 已自动作废（留痕），按最新一版执行`
      : `${code} 已登记，进入待调度`,
  }
}

// 闸门与内涝处置共用一套自增 id（终止会往内涝表写单），取两表最大值 +1。
function nextId(): number {
  const all = reloadCache()
  const maxOf = (key: string) =>
    (all[key] ?? []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  return Math.max(maxOf('floodgate'), maxOf('waterlog')) + 1
}

function nextOrderCode(rows: EntryRow[]): string {
  const seq =
    rows.reduce((max, row) => {
      const m = /^ZM-(\d+)$/.exec(String(row.调度编号 ?? ''))
      return m ? Math.max(max, Number(m[1])) : max
    }, 0) + 1
  return `ZM-${String(seq).padStart(4, '0')}`
}

// ---------- 观察一轮 ----------

/** 水位差超阈值时先观察一轮：记录观察时的水位读数，观察轮次 +1。 */
export function recordObservation(
  id: number,
  upstream: number,
  downstream: number,
  operator: string,
  version: number,
): ActionResult {
  const row = latestRow(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的闸门调度单` }
  }
  const versionError = checkVersion(row, version)
  if (versionError) {
    return { ok: false, message: versionError }
  }
  if (String(row.status) !== GATE_STATUS.pending) {
    return { ok: false, message: `只有「${GATE_STATUS.pending}」的单子能登记观察，当前是「${row.status}」` }
  }
  if (Number.isNaN(upstream) || Number.isNaN(downstream)) {
    return { ok: false, message: '观察的上、下游水位读数必须是有效数字' }
  }
  const locked = acquireGateLock(String(row.闸门名称), operator)
  if (!locked.ok) {
    return locked
  }

  const rows = latestRowsAll()
  const target = rows.find((item) => Number(item.id) === id)!
  const rounds = Number(target.__observeRounds ?? 0) + 1
  target.上游水位 = upstream
  target.下游水位 = downstream
  target.水位差 = +Math.abs(upstream - downstream).toFixed(2)
  target.__observeRounds = rounds
  target.__version = Number(target.__version ?? 1) + 1
  target.__lastBy = operator
  target.__lastAt = nowText()

  appendTrace({
    gate: String(target.闸门名称),
    orderCode: String(target.调度编号),
    type: '观察',
    detail: `完成第 ${rounds} 轮观察，上/下游水位更新为 ${upstream}/${downstream}m，水位差 ${target.水位差}m`,
    operator,
  })
  persist(rows)
  releaseGateLock(String(target.闸门名称), operator)
  return { ok: true, message: `已记录第 ${rounds} 轮观察水位，可以提交开闸` }
}

/** 待调度 → 执行中。仍要卡口径与「先观察一轮」，且同一道闸先到先得。 */
export function startOrder(id: number, operator: string, version: number): ActionResult {
  const preview = latestRow(id)
  if (!preview) {
    return { ok: false, message: `没有找到编号为 ${id} 的闸门调度单` }
  }
  const gate = String(preview.闸门名称)
  const locked = acquireGateLock(gate, operator)
  if (!locked.ok) {
    return locked
  }
  // 锁拿到后再读一遍，确认期间没被别人改动。
  const row = latestRow(id)!
  const versionError = checkVersion(row, version)
  if (versionError) {
    releaseGateLock(gate, operator)
    return { ok: false, message: versionError }
  }
  if (String(row.status) !== GATE_STATUS.pending) {
    releaseGateLock(gate, operator)
    return { ok: false, message: `只有「${GATE_STATUS.pending}」能执行，当前是「${row.status}」` }
  }

  const limit = getOpeningLimit(gate, String(row.所属河渠))
  const openingError = checkOpening(limit, gate, num(row.闸门开度))
  if (openingError) {
    releaseGateLock(gate, operator)
    return { ok: false, message: openingError }
  }
  const head = num(row.水位差)
  if (limit && head > limit.headThreshold) {
    const rounds = Number(row.__observeRounds ?? 0)
    releaseGateLock(gate, operator)
    if (rounds < 1) {
      return {
        ok: false,
        message: `上下游水位差 ${head}m 已超过 ${limit.headThreshold}m，必须先观察一轮再开闸`,
      }
    }
    return {
      ok: false,
      message: `已观察 ${rounds} 轮，但最新一轮读数水位差仍有 ${head}m（阈值 ${limit.headThreshold}m），请再观察一轮确认回落后再开`,
    }
  }
  if (row.__alarm) {
    releaseGateLock(gate, operator)
    return { ok: false, message: '该单当前挂着口径越界告警，请先按口径修正开度再执行' }
  }

  const rows = latestRowsAll()
  const target = rows.find((item) => Number(item.id) === id)!
  target.status = GATE_STATUS.running
  target.pending = true
  target.__version = Number(target.__version ?? 1) + 1
  target.__lastBy = operator
  target.__lastAt = nowText()
  target.开始时间 = nowText()
  appendTrace({
    gate,
    orderCode: String(target.调度编号),
    type: '执行',
    detail: `进入执行中，开度 ${target.闸门开度}%，上/下游水位 ${target.上游水位}/${target.下游水位}m`,
    operator,
  })
  persist(rows)
  releaseGateLock(gate, operator)
  return { ok: true, message: `${target.调度编号} 已进入执行中` }
}

/**
 * 执行中 → 已终止（终态）。终止时把当时的上、下游水位读数连同开度一起存进记录，
 * 并把终止结论落到内涝处置的待派队（待处置）清单。
 */
export function terminateOrder(input: TerminateInput): ActionResult {
  const row = latestRow(input.id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的闸门调度单` }
  }
  const versionError = checkVersion(row, input.version)
  if (versionError) {
    return { ok: false, message: versionError }
  }
  if (String(row.status) !== GATE_STATUS.running) {
    return { ok: false, message: `只有「${GATE_STATUS.running}」的单子能终止，当前是「${row.status}」` }
  }
  if (Number.isNaN(input.upstream) || Number.isNaN(input.downstream)) {
    return { ok: false, message: '终止时的上、下游水位读数必须是有效数字' }
  }
  const gate = String(row.闸门名称)
  const locked = acquireGateLock(gate, input.operator)
  if (!locked.ok) {
    return locked
  }

  const all = reloadCache()
  const rows = (all.floodgate ?? []).map((item) => ({ ...item }))
  const target = rows.find((item) => Number(item.id) === input.id)!
  target.上游水位 = input.upstream
  target.下游水位 = input.downstream
  target.水位差 = +Math.abs(input.upstream - input.downstream).toFixed(2)
  // 终止留底：把终止当时的水位读数与开度快照一起存下来。
  target.终止上游水位 = input.upstream
  target.终止下游水位 = input.downstream
  target.终止水位差 = target.水位差
  target.终止开度 = target.闸门开度
  target.终止时间 = nowText()
  target.终止人 = input.operator
  target.status = GATE_STATUS.terminated
  target.pending = false
  target.abnormal = false
  target.__version = Number(target.__version ?? 1) + 1
  target.__lastBy = input.operator
  target.__lastAt = target.终止时间

  appendTrace({
    gate,
    orderCode: String(target.调度编号),
    type: '终止',
    detail: `调度终止并存下当时水位：上/下游 ${input.upstream}/${input.downstream}m，水位差 ${target.水位差}m，开度 ${target.闸门开度}%；结论转入内涝处置待派队清单`,
    operator: input.operator,
  })

  // 落到内涝处置的「待处置 = 待派队」清单。
  const waterRows = (all.waterlog ?? []).map((item) => ({ ...item }))
  const waterId = nextId()
  waterRows.push({
    id: waterId,
    status: WATERLOG_PENDING,
    pending: true,
    abnormal: false,
    内涝编号: `NL-${String(waterId).padStart(4, '0')}`,
    内涝点位: `${gate}（${target.所属河渠}）`,
    积水深度: '待现场核定',
    影响范围: `闸门 ${target.调度编号} 终止转出，上下游水位差 ${target.水位差}m`,
    处置队: '',
    到场时间: '',
    退水时间: '',
    处置状态: WATERLOG_PENDING,
    来源调度单: target.调度编号,
    登记时间: nowText(),
  })

  persist(rows)
  saveRows('waterlog', waterRows)
  releaseGateLock(gate, input.operator)
  return {
    ok: true,
    message: `${target.调度编号} 已终止，当时水位读数已存档，并已生成内涝处置待派队单 NL-${String(waterId).padStart(4, '0')}`,
  }
}

/**
 * 改闸门开度。改动必须仍在口径区间内（越界退回并写清超出多少），
 * 且每次改动都留痕：谁、什么时候、从多少改成多少、为什么。
 */
export function adjustOpening(input: AdjustInput): ActionResult {
  if (Number.isNaN(input.opening)) {
    return { ok: false, message: '新开度不是有效数字' }
  }
  if (!input.reason.trim()) {
    return { ok: false, message: '调整开度必须填写调整原因，便于倒查' }
  }
  const row = latestRow(input.id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的闸门调度单` }
  }
  const versionError = checkVersion(row, input.version)
  if (versionError) {
    return { ok: false, message: versionError }
  }
  if (!ACTIVE_STATUSES.includes(String(row.status))) {
    return { ok: false, message: `只有在执行的单子能改开度，当前是「${row.status}」` }
  }
  const gate = String(row.闸门名称)
  const locked = acquireGateLock(gate, input.operator)
  if (!locked.ok) {
    return locked
  }
  const limit = getOpeningLimit(gate, String(row.所属河渠))
  const openingError = checkOpening(limit, gate, input.opening)
  if (openingError) {
    releaseGateLock(gate, input.operator)
    return { ok: false, message: openingError }
  }

  const rows = latestRowsAll()
  const target = rows.find((item) => Number(item.id) === input.id)!
  const before = num(target.闸门开度)
  target.闸门开度 = input.opening
  if (!Number.isNaN(input.upstream)) {
    target.上游水位 = input.upstream
  }
  if (!Number.isNaN(input.downstream)) {
    target.下游水位 = input.downstream
    target.水位差 = +Math.abs(num(target.上游水位) - input.downstream).toFixed(2)
  }
  target.__alarm = false
  target.__version = Number(target.__version ?? 1) + 1
  target.__lastBy = input.operator
  target.__lastAt = nowText()

  appendTrace({
    gate,
    orderCode: String(target.调度编号),
    type: '改开度',
    detail: `开度 ${before}% → ${input.opening}%（口径 ${limit!.min}%~${limit!.max}%），原因：${input.reason.trim()}`,
    operator: input.operator,
  })
  persist(rows)
  releaseGateLock(gate, input.operator)
  return { ok: true, message: `${target.调度编号} 开度已由 ${before}% 改为 ${input.opening}%，改动已留痕` }
}

// ---------- 查询：留痕与锁 ----------

/** 倒查闸门开度/调度改动：可按闸门或调度单过滤，最新在前。 */
export function listTraces(filter: { gate?: string; code?: string } = {}): GateTrace[] {
  return readTraces()
    .filter(
      (trace) =>
        (!filter.gate || trace.gate.includes(filter.gate)) &&
        (!filter.code || trace.orderCode.includes(filter.code)),
    )
    .map((item) => ({ ...item }))
}

export function listActiveLocks(): GateLock[] {
  return readLocks().map((item) => ({ ...item }))
}

export function releaseLock(gate: string): void {
  writeJson(
    LOCK_KEY,
    readLocks().filter((lock) => lock.gate !== gate),
  )
}

// 口径初始值：首次使用播种，之后以 localStorage 里调整过的版本为准。
export function ensureDefaultLimits(
  defaults: Pick<OpeningLimit, 'gate' | 'canal' | 'min' | 'max' | 'headThreshold'>[],
): void {
  const current = readLimits()
  if (current.length > 0) {
    return
  }
  const stamp = nowText()
  writeJson(
    LIMIT_KEY,
    defaults.map((item) => ({ ...item, version: 1, updatedAt: stamp, updatedBy: '系统初始化' })),
  )
}

// 供看板/页面直接取在执行调度单。
export function listGateRows(): EntryRow[] {
  return (listRows('floodgate') ?? []).map((row) => ({ ...row }))
}

// ---------- 首次进入：口径初始值 + 把脚手架占位示例换成域内演示单 ----------

const DEFAULT_LIMITS = [
  { gate: '东环河1号闸', canal: '东环河', min: 20, max: 70, headThreshold: 0.5 },
  { gate: '西港2号闸', canal: '西港河', min: 15, max: 60, headThreshold: 0.4 },
  { gate: '南渠3号闸', canal: '南渠', min: 10, max: 50, headThreshold: 0.6 },
]

function domainRow(partial: {
  id: number
  status: string
  [field: string]: string | number | boolean
}): EntryRow {
  const stamp = nowText()
  const base = {
    __domain: DOMAIN_TAG,
    __version: 1,
    __observeRounds: 0,
    __alarm: false,
    __lastBy: '系统初始化',
    __lastAt: stamp,
  }
  return { pending: true, abnormal: false, ...base, ...partial }
}

/**
 * 首次进入闸门页时执行一次：写入默认开度口径，并把脚手架自带的「闸门调度样例N」
 * 占位数据替换成符合本域规则的演示单。之后以 localStorage 为准，不再覆盖。
 */
export function initGateDomain(): void {
  ensureDefaultLimits(DEFAULT_LIMITS)
  const rows = listRows('floodgate') ?? []
  const already = rows.some((row) => row.__domain === DOMAIN_TAG)
  if (already) {
    return
  }

  const stamp = nowText()
  const seed: EntryRow[] = [
    domainRow({
      id: 1,
      status: GATE_STATUS.pending,
      调度编号: 'ZM-0001',
      闸门名称: '东环河1号闸',
      所属河渠: '东环河',
      调度时段: '2026-10-05 08:00-12:00',
      闸门开度: 40,
      上游水位: 3.2,
      下游水位: 2.4,
      水位差: 0.8,
      调度人: '值班管理员',
      登记时间: stamp,
    }),
    domainRow({
      id: 2,
      status: GATE_STATUS.running,
      调度编号: 'ZM-0002',
      闸门名称: '西港2号闸',
      所属河渠: '西港河',
      调度时段: '2026-10-05 08:00-12:00',
      闸门开度: 35,
      上游水位: 2.9,
      下游水位: 2.7,
      水位差: 0.2,
      调度人: '值班管理员',
      登记时间: stamp,
      开始时间: stamp,
      __observeRounds: 1,
    }),
    domainRow({
      id: 3,
      status: GATE_STATUS.terminated,
      pending: false,
      调度编号: 'ZM-0000',
      闸门名称: '南渠3号闸',
      所属河渠: '南渠',
      调度时段: '2026-10-04 20:00-24:00',
      闸门开度: 30,
      上游水位: 3.0,
      下游水位: 2.8,
      水位差: 0.2,
      调度人: '夜班值班员',
      登记时间: stamp,
      终止开度: 30,
      终止上游水位: 3.0,
      终止下游水位: 2.8,
      终止水位差: 0.2,
      终止时间: stamp,
      终止人: '夜班值班员',
    }),
  ]
  persist(seed)

  if (readTraces().length === 0) {
    appendTrace({
      gate: '西港2号闸',
      orderCode: 'ZM-0002',
      type: '观察',
      detail: '完成第 1 轮观察，上/下游水位 2.9/2.7m，水位差 0.2m',
      operator: '值班管理员',
    })
    appendTrace({
      gate: '西港2号闸',
      orderCode: 'ZM-0002',
      type: '执行',
      detail: '进入执行中，开度 35%',
      operator: '值班管理员',
    })
    appendTrace({
      gate: '南渠3号闸',
      orderCode: 'ZM-0000',
      type: '终止',
      detail: '调度终止并存下当时水位：上/下游 3.0/2.8m，开度 30%；结论转入内涝处置待派队清单',
      operator: '夜班值班员',
    })
  }
}
