import { appendGateAudit, listGateAudit, listGateRules, saveGateRules } from '@/data/floodgate'
import type { GateRule } from '@/data/floodgate'
import { listRows, refreshRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 闸门调度的业务规则全部收在这里，页面只负责渲染和收集输入。
// 口径：按闸门名称+所属河渠设上下限，区间外的单子不许提交，退回写清超出多少。
// 流转：待调度 → 执行中 → 已终止，别无他路；「已作废」是系统对重复下单的自动处理。
const MODULE = 'floodgate'
const RESCUE_MODULE = 'rescueteam'

const FLOW: Record<string, { from: string; to: string }> = {
  提交调度: { from: '待调度', to: '执行中' },
  终止调度: { from: '执行中', to: '已终止' },
}

export type DispatchDraft = {
  闸门名称: string
  所属河渠: string
  调度时段: string
  闸门开度: number
  上游水位: number
  下游水位: number
}

export type RuleDraft = {
  id: number
  闸门名称: string
  所属河渠: string
  开度下限: number
  开度上限: number
  水位差阈值: number
}

export type TerminateDraft = {
  终止结论: string
  终止时上游水位: number
  终止时下游水位: number
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 写操作前先把缓存扔掉，保证读到的是别的标签页刚写入的最新版本。
function freshRows(key: string): EntryRow[] {
  refreshRows()
  return listRows(key)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextTicket(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = String(row[field] ?? '').match(/(\d+)$/)
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function ruleFor(gate: string, river: string, rules: GateRule[] = listGateRules()): GateRule | undefined {
  return rules.find((item) => item.闸门名称 === gate && item.所属河渠 === river)
}

// 退回时写清超出了多少：上超写下超的差值，下欠写还差多少。
function openingViolation(rule: GateRule, opening: number): string {
  if (opening > rule.开度上限) {
    return `开度 ${opening.toFixed(2)}m 超出「${rule.闸门名称}/${rule.所属河渠}」口径上限 ${rule.开度上限.toFixed(2)}m，超出 ${(opening - rule.开度上限).toFixed(2)}m`
  }
  if (opening < rule.开度下限) {
    return `开度 ${opening.toFixed(2)}m 低于「${rule.闸门名称}/${rule.所属河渠}」口径下限 ${rule.开度下限.toFixed(2)}m，还差 ${(rule.开度下限 - opening).toFixed(2)}m`
  }
  return ''
}

// 同一道闸被两个人同时操作时只认先到的那一次：记录带版本号，
// 页面按自己看到的版本号来改，对不上说明已经有人抢先处理过。
function claim(rows: EntryRow[], id: number, seenVersion: number): { index: number } | { error: string } {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { error: `没有找到编号为 ${id} 的闸门调度记录` }
  }
  const row = rows[index]
  if (Number(row.version ?? 1) !== seenVersion) {
    return {
      error: `「${row.闸门名称}」的调度单刚被 ${row.最后操作人 ?? '他人'} 于 ${row.最后操作时间 ?? '未知时间'} 抢先处理，本次操作未生效，请刷新列表后重办`,
    }
  }
  return { index }
}

function touch(row: EntryRow, operator: string): EntryRow {
  return {
    ...row,
    version: Number(row.version ?? 1) + 1,
    最后操作人: operator,
    最后操作时间: now(),
  }
}

function checkFlow(row: EntryRow, action: string): string {
  const flow = FLOW[action]
  const current = String(row.status)
  if (current === flow.from) {
    return ''
  }
  if (current === '已作废') {
    return `调度单 ${row.调度编号} 已被新版本替代作废，不能再${action}`
  }
  return `调度状态只能从待调度到执行中、再到已终止，当前「${current}」不能执行「${action}」`
}

function writeModule(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows(MODULE, next)
}

// 下发调度单：先校口径，再把同一道闸同一时段的旧待执行单自动作废留痕。
export function createDispatch(draft: DispatchDraft, operator: string): ActionResult {
  const gate = draft.闸门名称.trim()
  const river = draft.所属河渠.trim()
  const period = draft.调度时段.trim()
  if (!gate || !river || !period) {
    return { ok: false, message: '闸门名称、所属河渠、调度时段都要填' }
  }
  const rule = ruleFor(gate, river)
  if (!rule) {
    return { ok: false, message: `尚未为「${gate}/${river}」登记开度口径，请先在口径管理里设好上下限` }
  }
  const violation = openingViolation(rule, draft.闸门开度)
  if (violation) {
    return { ok: false, message: `${violation}，单子不许提交，已退回` }
  }
  const rows = freshRows(MODULE)
  const ticket = nextTicket(rows, '调度编号', 'FLOO')
  const ts = now()
  const voided: EntryRow[] = []
  const kept = rows.map((row) => {
    if (row.status === '待调度' && row.闸门名称 === gate && String(row.调度时段 ?? '') === period) {
      voided.push(row)
      return {
        ...row,
        status: '已作废',
        pending: false,
        调度状态: '已作废',
        作废原因: `被新调度单 ${ticket} 替代`,
        作废时间: ts,
        version: Number(row.version ?? 1) + 1,
        最后操作人: '系统',
        最后操作时间: ts,
      }
    }
    return row
  })
  const fresh: EntryRow = {
    id: nextId(rows),
    status: '待调度',
    pending: true,
    abnormal: false,
    调度编号: ticket,
    闸门名称: gate,
    所属河渠: river,
    调度时段: period,
    闸门开度: draft.闸门开度,
    上游水位: draft.上游水位,
    下游水位: draft.下游水位,
    调度人: operator,
    调度状态: '待调度',
    观察记录: '未观察',
    version: 1,
    最后操作人: operator,
    最后操作时间: ts,
  }
  saveRows(MODULE, [...kept, fresh])
  for (const old of voided) {
    appendGateAudit({
      时间: ts,
      操作人: '系统',
      调度编号: String(old.调度编号),
      闸门名称: gate,
      动作: '自动作废',
      旧开度: String(old.闸门开度),
      新开度: '',
      说明: `同一道闸同一时段重复下发，按最新一版 ${ticket} 执行，本单作废留痕`,
    })
  }
  appendGateAudit({
    时间: ts,
    操作人: operator,
    调度编号: ticket,
    闸门名称: gate,
    动作: '下发调度',
    旧开度: '',
    新开度: draft.闸门开度.toFixed(2),
    说明: `时段 ${period}，口径 ${rule.开度下限.toFixed(2)}~${rule.开度上限.toFixed(2)}m`,
  })
  const replaced = voided.length
    ? `；同时段旧单 ${voided.map((row) => row.调度编号).join('、')} 已自动作废留痕`
    : ''
  return { ok: true, message: `调度单 ${ticket} 已下发，当前「待调度」${replaced}` }
}

// 提交调度：待调度 → 执行中。超口径不许提交；水位差超阈值必须先观察一轮再开。
export function submitDispatch(id: number, operator: string, seenVersion: number): ActionResult {
  const rows = freshRows(MODULE)
  const got = claim(rows, id, seenVersion)
  if ('error' in got) {
    return { ok: false, message: got.error }
  }
  const row = rows[got.index]
  const flowError = checkFlow(row, '提交调度')
  if (flowError) {
    return { ok: false, message: flowError }
  }
  const rule = ruleFor(String(row.闸门名称), String(row.所属河渠))
  if (!rule) {
    return { ok: false, message: `尚未为「${row.闸门名称}/${row.所属河渠}」登记开度口径，不能提交` }
  }
  const violation = openingViolation(rule, Number(row.闸门开度))
  if (violation) {
    return { ok: false, message: `${violation}，单子不许提交，退回「待调度」` }
  }
  const diff = Math.abs(Number(row.上游水位) - Number(row.下游水位))
  if (diff > rule.水位差阈值 && String(row.观察记录 ?? '未观察') !== '已观察') {
    return {
      ok: false,
      message: `上下游水位差 ${diff.toFixed(2)}m 超过阈值 ${rule.水位差阈值.toFixed(2)}m，必须先登记观察一轮再开`,
    }
  }
  writeModule(rows, got.index, touch({ ...row, status: '执行中', 调度状态: '执行中', pending: true }, operator))
  appendGateAudit({
    时间: now(),
    操作人: operator,
    调度编号: String(row.调度编号),
    闸门名称: String(row.闸门名称),
    动作: '提交调度',
    旧开度: '',
    新开度: Number(row.闸门开度).toFixed(2),
    说明: `水位差 ${diff.toFixed(2)}m，闸门进入执行中`,
  })
  return { ok: true, message: `调度单 ${row.调度编号} 已提交，闸门进入「执行中」` }
}

// 登记观察：水位差超阈值的单子，观察过一轮才允许提交。
export function observeDispatch(id: number, operator: string, seenVersion: number, note: string): ActionResult {
  const rows = freshRows(MODULE)
  const got = claim(rows, id, seenVersion)
  if ('error' in got) {
    return { ok: false, message: got.error }
  }
  const row = rows[got.index]
  if (String(row.status) !== '待调度') {
    return { ok: false, message: `只有「待调度」的单子能登记观察，当前「${row.status}」` }
  }
  const ts = now()
  const diff = Math.abs(Number(row.上游水位) - Number(row.下游水位))
  const updated = touch(
    {
      ...row,
      观察记录: '已观察',
      观察时间: ts,
      观察人: operator,
      观察结论: note || '观察一轮，水位无异常',
    },
    operator,
  )
  writeModule(rows, got.index, updated)
  appendGateAudit({
    时间: ts,
    操作人: operator,
    调度编号: String(row.调度编号),
    闸门名称: String(row.闸门名称),
    动作: '登记观察',
    旧开度: '',
    新开度: '',
    说明: `水位差 ${diff.toFixed(2)}m；${updated.观察结论}`,
  })
  return { ok: true, message: `调度单 ${row.调度编号} 已登记观察，可以提交调度` }
}

// 调整开度：待调度、执行中都能改，超口径不落地；谁改的、什么时候改的全部留痕。
export function adjustOpening(id: number, operator: string, seenVersion: number, opening: number): ActionResult {
  const rows = freshRows(MODULE)
  const got = claim(rows, id, seenVersion)
  if ('error' in got) {
    return { ok: false, message: got.error }
  }
  const row = rows[got.index]
  if (!['待调度', '执行中'].includes(String(row.status))) {
    return { ok: false, message: `调度单已是「${row.status}」，开度不能再改` }
  }
  const rule = ruleFor(String(row.闸门名称), String(row.所属河渠))
  if (!rule) {
    return { ok: false, message: `尚未为「${row.闸门名称}/${row.所属河渠}」登记开度口径，不能改开度` }
  }
  const violation = openingViolation(rule, opening)
  if (violation) {
    return { ok: false, message: `${violation}，开度未改动` }
  }
  const before = Number(row.闸门开度)
  const updated = touch({ ...row, 闸门开度: opening, abnormal: false, 口径复核: '符合现行口径' }, operator)
  writeModule(rows, got.index, updated)
  appendGateAudit({
    时间: now(),
    操作人: operator,
    调度编号: String(row.调度编号),
    闸门名称: String(row.闸门名称),
    动作: '调整开度',
    旧开度: before.toFixed(2),
    新开度: opening.toFixed(2),
    说明: `口径 ${rule.开度下限.toFixed(2)}~${rule.开度上限.toFixed(2)}m`,
  })
  return { ok: true, message: `调度单 ${row.调度编号} 开度已由 ${before.toFixed(2)}m 调整为 ${opening.toFixed(2)}m，改动已留痕` }
}

// 终止调度：执行中 → 已终止。当时的水位读数随单存档，
// 终止结论自动生成一条内涝处置的待派队任务。
export function terminateDispatch(id: number, operator: string, seenVersion: number, draft: TerminateDraft): ActionResult {
  const rows = freshRows(MODULE)
  const got = claim(rows, id, seenVersion)
  if ('error' in got) {
    return { ok: false, message: got.error }
  }
  const row = rows[got.index]
  const flowError = checkFlow(row, '终止调度')
  if (flowError) {
    return { ok: false, message: flowError }
  }
  const conclusion = draft.终止结论.trim()
  if (!conclusion) {
    return { ok: false, message: '终止调度必须填写终止结论，结论要落到内涝处置待派队清单' }
  }
  const ts = now()
  const updated = touch(
    {
      ...row,
      status: '已终止',
      调度状态: '已终止',
      pending: false,
      终止结论: conclusion,
      终止时上游水位: draft.终止时上游水位,
      终止时下游水位: draft.终止时下游水位,
      终止时间: ts,
      终止人: operator,
    },
    operator,
  )
  writeModule(rows, got.index, updated)
  const teamRows = freshRows(RESCUE_MODULE)
  const taskTicket = nextTicket(teamRows, '任务编号', 'RESC')
  const task: EntryRow = {
    id: nextId(teamRows),
    status: '待派队',
    pending: true,
    abnormal: false,
    任务编号: taskTicket,
    任务类型: '内涝处置',
    目标点位: `${row.闸门名称}（${row.所属河渠}）`,
    抢险队: '待指派',
    出队时间: '-',
    归队时间: '-',
    负责人: operator,
    任务状态: '待派队',
    处置结论: `闸门调度单 ${row.调度编号} 终止：${conclusion}（终止时水位 上 ${draft.终止时上游水位.toFixed(2)}m / 下 ${draft.终止时下游水位.toFixed(2)}m）`,
  }
  saveRows(RESCUE_MODULE, [...teamRows, task])
  appendGateAudit({
    时间: ts,
    操作人: operator,
    调度编号: String(row.调度编号),
    闸门名称: String(row.闸门名称),
    动作: '终止调度',
    旧开度: Number(row.闸门开度).toFixed(2),
    新开度: '',
    说明: `水位读数 上 ${draft.终止时上游水位.toFixed(2)}m / 下 ${draft.终止时下游水位.toFixed(2)}m 已存档；结论已生成内涝处置待派队任务 ${taskTicket}`,
  })
  return { ok: true, message: `调度单 ${row.调度编号} 已终止，水位读数已存档，终止结论已落入内涝处置待派队清单（任务 ${taskTicket}）` }
}

// 保存口径：新增或调整都走这里。口径一旦调整，立刻按新口径重算所有执行中的单子，
// 落不到新区间的标异常并留痕，回到区间内的摘掉异常标记。
export function saveGateRule(draft: RuleDraft, operator: string): ActionResult {
  const gate = draft.闸门名称.trim()
  const river = draft.所属河渠.trim()
  if (!gate || !river) {
    return { ok: false, message: '闸门名称、所属河渠都要填' }
  }
  if (!(draft.开度下限 >= 0) || !(draft.开度上限 > draft.开度下限)) {
    return { ok: false, message: '开度上限必须大于下限，且下限不能为负' }
  }
  if (!(draft.水位差阈值 > 0)) {
    return { ok: false, message: '水位差阈值必须大于 0' }
  }
  const rules = listGateRules()
  const ts = now()
  const targetId = draft.id > 0 ? draft.id : (rules.find((item) => item.闸门名称 === gate && item.所属河渠 === river)?.id ?? 0)
  const saved: GateRule = {
    id: targetId || rules.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    闸门名称: gate,
    所属河渠: river,
    开度下限: draft.开度下限,
    开度上限: draft.开度上限,
    水位差阈值: draft.水位差阈值,
    更新人: operator,
    更新时间: ts,
  }
  const nextRules = targetId ? rules.map((item) => (item.id === targetId ? saved : item)) : [...rules, saved]
  saveGateRules(nextRules)
  appendGateAudit({
    时间: ts,
    操作人: operator,
    调度编号: '-',
    闸门名称: gate,
    动作: '调整口径',
    旧开度: '',
    新开度: '',
    说明: `「${gate}/${river}」口径定为 ${saved.开度下限.toFixed(2)}~${saved.开度上限.toFixed(2)}m，水位差阈值 ${saved.水位差阈值.toFixed(2)}m`,
  })
  let rechecked = 0
  let flagged = 0
  const rows = freshRows(MODULE)
  const updatedRows = rows.map((row) => {
    if (String(row.status) !== '执行中') {
      return row
    }
    const rule = ruleFor(String(row.闸门名称), String(row.所属河渠), nextRules)
    if (!rule) {
      return row
    }
    rechecked += 1
    const violation = openingViolation(rule, Number(row.闸门开度))
    if (violation) {
      flagged += 1
      appendGateAudit({
        时间: ts,
        操作人: '系统',
        调度编号: String(row.调度编号),
        闸门名称: String(row.闸门名称),
        动作: '口径重算',
        旧开度: Number(row.闸门开度).toFixed(2),
        新开度: '',
        说明: `${violation}（按 ${ts} 新口径重算）`,
      })
      return {
        ...row,
        abnormal: true,
        口径复核: violation,
        version: Number(row.version ?? 1) + 1,
        最后操作人: '系统·口径重算',
        最后操作时间: ts,
      }
    }
    if (row.abnormal || row.口径复核) {
      return {
        ...row,
        abnormal: false,
        口径复核: '符合现行口径',
        version: Number(row.version ?? 1) + 1,
        最后操作人: '系统·口径重算',
        最后操作时间: ts,
      }
    }
    return row
  })
  saveRows(MODULE, updatedRows)
  const recalc = rechecked
    ? `按新口径重算执行中调度 ${rechecked} 单，${flagged ? `${flagged} 单落不到新区间，已标异常` : '均在区间内'}`
    : '当前没有执行中的调度需要重算'
  return { ok: true, message: `口径已保存；${recalc}` }
}

export { listGateAudit, listGateRules }
