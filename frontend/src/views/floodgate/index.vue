<template>
  <section class="page" data-module="floodgate">
    <header class="page-head">
      <div>
        <h2>闸门调度管理</h2>
        <p class="page-desc">
          按「闸门名称 + 所属河渠」设开度口径；区间外的单子不许提交，水位差超阈值先观察一轮再开；
          状态只能 待调度 → 执行中 → 已终止，旧版自动作废留痕，开度改动全程可倒查。
        </p>
      </div>
      <div class="page-actions">
        <label class="toolbar-line" style="margin:0">
          <span class="subtle">当前操作人</span>
          <select v-model="operator" @change="reload">
            <option v-for="name in operators" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="gate-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="gate-tab"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'" style="font-size:13px">{{ message }}</p>

    <!-- ============ 调度单 ============ -->
    <template v-if="activeTab === 'orders'">
      <div class="gate-panel">
        <h3>登记调度单（重复下发同一道闸同一时段，旧单自动作废，按最新一版执行）</h3>
        <form class="gate-form" @submit.prevent="submitOrder">
          <label>
            <span>闸门名称</span>
            <input v-model="form.gate" list="gate-names" placeholder="如：东环河1号闸" />
          </label>
          <label>
            <span>所属河渠</span>
            <input v-model="form.canal" placeholder="如：东环河" />
          </label>
          <label>
            <span>调度时段</span>
            <input v-model="form.period" placeholder="如：2026-10-05 08:00-12:00" />
          </label>
          <label>
            <span>闸门开度（%）</span>
            <input v-model.number="form.opening" type="number" min="0" max="100" step="0.5" />
          </label>
          <label>
            <span>上游水位（m）</span>
            <input v-model.number="form.upstream" type="number" step="0.01" />
          </label>
          <label>
            <span>下游水位（m）</span>
            <input v-model.number="form.downstream" type="number" step="0.01" />
          </label>
          <div class="form-actions">
            <button class="btn primary" type="submit">提交调度单</button>
            <span v-if="currentLimit" class="subtle" style="align-self:center">
              当前口径 {{ currentLimit.min }}%~{{ currentLimit.max }}%，水位差阈值 {{ currentLimit.headThreshold }}m
            </span>
            <span v-else-if="form.gate" class="subtle" style="align-self:center;color:#b42318">该闸尚未设口径，提交会被退回</span>
          </div>
        </form>
        <datalist id="gate-names">
          <option v-for="limit in limits" :key="limit.gate + limit.canal" :value="limit.gate" />
        </datalist>
      </div>

      <div class="toolbar-line">
        <input v-model="filterText" placeholder="按闸门名称 / 调度编号 / 河渠检索" style="min-width:240px" />
        <button class="btn" type="button" @click="reload">刷新（拉取最新版本）</button>
        <span class="subtle">同一道闸两人同时操作只认先到的一次，可在「并发锁」里查看占用情况</span>
      </div>

      <div class="gate-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>调度编号</th><th>闸门名称</th><th>所属河渠</th><th>调度时段</th>
              <th>开度(%)</th><th>上游(m)</th><th>下游(m)</th><th>水位差(m)</th>
              <th>观察</th><th>调度人</th><th>状态 / 标记</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredRows" :key="String(row.id)">
              <td>{{ row.调度编号 }}</td>
              <td>{{ row.闸门名称 }}</td>
              <td>{{ row.所属河渠 }}</td>
              <td>{{ row.调度时段 }}</td>
              <td>{{ row.闸门开度 }}</td>
              <td>{{ row.上游水位 }}</td>
              <td>{{ row.下游水位 }}</td>
              <td>{{ row.水位差 }}</td>
              <td>{{ Number(row.__observeRounds ?? 0) }} 轮</td>
              <td>{{ row.调度人 }}</td>
              <td>
                <span class="badge" :class="statusBadge(row.status)">{{ row.status }}</span>
                <div v-if="row.__alarm" class="badge bad">口径越界</div>
                <div v-if="needsObserve(row)" class="badge warn">需先观察</div>
                <div v-if="row.__supersededBy" class="subtle">被 {{ row.__supersededBy }} 顶换</div>
                <div v-if="row.终止时间" class="subtle">终止于 {{ row.终止时间 }}</div>
              </td>
              <td class="row-actions" style="flex-direction:column;align-items:flex-start">
                <button v-if="row.status === '待调度'" class="link" type="button" @click="openObserve(row)">登记观察读数</button>
                <button
                  v-if="row.status === '待调度'"
                  class="link"
                  type="button"
                  :disabled="Boolean(row.__alarm)"
                  @click="start(row)"
                >开始执行</button>
                <button v-if="row.status === '执行中'" class="link" type="button" @click="openAdjust(row)">改开度</button>
                <button v-if="row.status === '执行中'" class="link" type="button" @click="openTerminate(row)">终止并存水位</button>
                <span v-if="row.status === '已终止'" class="subtle">终读 上{{ row.终止上游水位 }}/下{{ row.终止下游水位 }}m</span>
              </td>
            </tr>
            <tr v-if="!filteredRows.length">
              <td colspan="12" class="empty-state">暂无调度单，可在上方先登记一条</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 口径管理 ============ -->
    <template v-else-if="activeTab === 'limits'">
      <div class="gate-panel">
        <h3>设置 / 调整开度口径（保存后立即按新口径重算该闸正在执行的单子）</h3>
        <form class="gate-form" @submit.prevent="saveLimit">
          <label>
            <span>闸门名称</span>
            <input v-model="limitForm.gate" list="gate-names2" placeholder="闸门名称" />
          </label>
          <label>
            <span>所属河渠</span>
            <input v-model="limitForm.canal" placeholder="所属河渠" />
          </label>
          <label>
            <span>开度下限（%）</span>
            <input v-model.number="limitForm.min" type="number" min="0" max="100" step="0.5" />
          </label>
          <label>
            <span>开度上限（%）</span>
            <input v-model.number="limitForm.max" type="number" min="0" max="100" step="0.5" />
          </label>
          <label>
            <span>水位差观察阈值（m）</span>
            <input v-model.number="limitForm.headThreshold" type="number" min="0" step="0.05" />
          </label>
          <div class="form-actions">
            <button class="btn primary" type="submit">保存口径并重算</button>
          </div>
        </form>
        <datalist id="gate-names2">
          <option v-for="limit in limits" :key="limit.gate + limit.canal" :value="limit.gate" />
        </datalist>
      </div>

      <div class="gate-table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>闸门名称</th><th>所属河渠</th><th>开度下限</th><th>开度上限</th><th>水位差阈值</th><th>版本</th><th>最近调整</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="limit in limits" :key="limit.gate + '|' + limit.canal">
              <td>{{ limit.gate }}</td>
              <td>{{ limit.canal }}</td>
              <td>{{ limit.min }}%</td>
              <td>{{ limit.max }}%</td>
              <td>{{ limit.headThreshold }}m</td>
              <td>v{{ limit.version }}</td>
              <td>{{ limit.updatedBy }} · {{ limit.updatedAt }}</td>
              <td><button class="link" type="button" @click="editLimit(limit)">载入表单调整</button></td>
            </tr>
            <tr v-if="!limits.length"><td colspan="8" class="empty-state">尚未配置任何开度口径</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 操作留痕 ============ -->
    <template v-else-if="activeTab === 'traces'">
      <div class="toolbar-line">
        <input v-model="traceGate" placeholder="按闸门名称过滤" />
        <input v-model="traceCode" placeholder="按调度编号过滤，如 ZM-0001" />
        <button class="btn" type="button" @click="loadTraces">查询</button>
      </div>
      <div class="gate-table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>时间</th><th>闸门</th><th>调度单</th><th>类型</th><th>操作人</th><th>内容</th></tr>
          </thead>
          <tbody>
            <tr v-for="trace in traces" :key="trace.id">
              <td>{{ trace.at }}</td>
              <td>{{ trace.gate }}</td>
              <td>{{ trace.orderCode }}</td>
              <td><span class="badge info">{{ trace.type }}</span></td>
              <td>{{ trace.operator }}</td>
              <td>{{ trace.detail }}</td>
            </tr>
            <tr v-if="!traces.length"><td colspan="6" class="empty-state">暂无留痕</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 并发锁 ============ -->
    <template v-else>
      <div class="gate-panel">
        <h3>同一道闸同时只认先到的一次操作</h3>
        <p class="subtle">锁在每次操作期间短暂占用（约 20 秒自动释放），后来的操作人会被挡下并提示是谁先操作的。</p>
        <table class="data-table">
          <thead><tr><th>闸门名称</th><th>先到操作人</th><th>占用开始时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="lock in activeLocks" :key="lock.gate">
              <td>{{ lock.gate }}</td>
              <td>{{ lock.operator }}</td>
              <td>{{ lock.at }}</td>
              <td><button class="link" type="button" @click="clearLock(lock.gate)">手动释放（仅演示/排障）</button></td>
            </tr>
            <tr v-if="!activeLocks.length"><td colspan="4" class="empty-state">当前没有闸门被占用</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  GATE_STATUS,
  adjustOpening,
  createGateOrder,
  initGateDomain,
  listActiveLocks,
  listGateRows,
  listOpeningLimits,
  listTraces,
  recordObservation,
  releaseLock,
  saveOpeningLimit,
  startOrder,
  terminateOrder,
} from '@/api/gate-dispatch'
import type { EntryRow } from '@/data/types'
import type { GateTrace, OpeningLimit } from '@/api/gate-dispatch'

const operators = ['值班管理员', '张工', '李工', '夜班值班员']
const operator = ref(operators[0])

const tabs = [
  { key: 'orders', label: '调度单' },
  { key: 'limits', label: '开度口径' },
  { key: 'traces', label: '操作留痕（倒查）' },
  { key: 'locks', label: '并发锁' },
] as const
const activeTab = ref<(typeof tabs)[number]['key']>('orders')

const rows = ref<EntryRow[]>([])
const limits = ref<OpeningLimit[]>([])
const traces = ref<GateTrace[]>([])
const activeLocks = ref(listActiveLocks())
const filterText = ref('')
const message = ref('')
const messageOk = ref(false)

const form = reactive({ gate: '', canal: '', period: '', opening: 40, upstream: 3, downstream: 2.8 })
const limitForm = reactive({ gate: '', canal: '', min: 20, max: 70, headThreshold: 0.5 })
const traceGate = ref('')
const traceCode = ref('')

const stats = computed(() => [
  { label: '待调度', value: rows.value.filter((r) => r.status === GATE_STATUS.pending).length },
  { label: '执行中', value: rows.value.filter((r) => r.status === GATE_STATUS.running).length },
  { label: '已终止', value: rows.value.filter((r) => r.status === GATE_STATUS.terminated).length },
  { label: '已作废（留痕）', value: rows.value.filter((r) => r.status === GATE_STATUS.voided).length },
])

const filteredRows = computed(() => {
  const kw = filterText.value.trim()
  if (!kw) {
    return rows.value
  }
  return rows.value.filter((row) =>
    [row.闸门名称, row.所属河渠, row.调度编号].some((v) => String(v ?? '').includes(kw)),
  )
})

const currentLimit = computed(() =>
  limits.value.find((item) => item.gate === form.gate.trim()),
)

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function switchTab(key: (typeof tabs)[number]['key']) {
  activeTab.value = key
  reload()
}

function reload() {
  rows.value = listGateRows()
  limits.value = listOpeningLimits()
  activeLocks.value = listActiveLocks()
  if (activeTab.value === 'traces') {
    loadTraces()
  }
}

function loadTraces() {
  traces.value = listTraces({ gate: traceGate.value.trim(), code: traceCode.value.trim() })
}

function submitOrder() {
  const result = createGateOrder({
    gate: form.gate,
    canal: form.canal,
    period: form.period,
    opening: Number(form.opening),
    upstream: Number(form.upstream),
    downstream: Number(form.downstream),
    operator: operator.value,
  })
  flash(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

function start(row: EntryRow) {
  const result = startOrder(Number(row.id), operator.value, Number(row.__version ?? 0))
  flash(result.ok, result.message)
  reload()
}

function needsObserve(row: EntryRow): boolean {
  if (row.status !== GATE_STATUS.pending) {
    return false
  }
  const limit = limits.value.find((item) => item.gate === row.闸门名称)
  return Boolean(limit && Number(row.水位差) > limit.headThreshold && Number(row.__observeRounds ?? 0) < 1)
}

function statusBadge(status: unknown): string {
  switch (status) {
    case GATE_STATUS.running:
      return 'info'
    case GATE_STATUS.terminated:
      return 'ok'
    case GATE_STATUS.voided:
      return 'bad'
    default:
      return 'warn'
  }
}

// 观察、改开度、终止都用浏览器 prompt 收读数/原因：纯前端演示够用，判断仍全在域服务里。
function promptNumber(title: string, value: number, allowBlank = false): number | null {
  const raw = window.prompt(title, String(value))
  if (raw === null) {
    return null
  }
  if (allowBlank && raw.trim() === '') {
    return NaN
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : NaN
}

function openObserve(row: EntryRow) {
  const up = promptNumber('观察读数：上游水位（m）', Number(row.上游水位))
  if (up === null || Number.isNaN(up)) {
    return
  }
  const down = promptNumber('观察读数：下游水位（m）', Number(row.下游水位))
  if (down === null || Number.isNaN(down)) {
    return
  }
  const result = recordObservation(Number(row.id), up, down, operator.value, Number(row.__version ?? 0))
  flash(result.ok, result.message)
  reload()
}

function openAdjust(row: EntryRow) {
  const opening = promptNumber(`把 ${row.调度编号} 的开度改为（%，当前 ${row.闸门开度}%）`, Number(row.闸门开度))
  if (opening === null || Number.isNaN(opening)) {
    return
  }
  const reason = window.prompt('调整开度的原因（必填，用于倒查）')
  if (reason === null) {
    return
  }
  const up = promptNumber('调整时上游水位（m），留空则不改', Number(row.上游水位), true)
  if (up === null) {
    return
  }
  const down = promptNumber('调整时下游水位（m），留空则不改', Number(row.下游水位), true)
  if (down === null) {
    return
  }
  const result = adjustOpening({
    id: Number(row.id),
    opening,
    upstream: up,
    downstream: down,
    reason,
    operator: operator.value,
    version: Number(row.__version ?? 0),
  })
  flash(result.ok, result.message)
  reload()
}

function openTerminate(row: EntryRow) {
  const up = promptNumber('终止时上游水位读数（m）', Number(row.上游水位))
  if (up === null || Number.isNaN(up)) {
    return
  }
  const down = promptNumber('终止时下游水位读数（m）', Number(row.下游水位))
  if (down === null || Number.isNaN(down)) {
    return
  }
  const result = terminateOrder({
    id: Number(row.id),
    upstream: up,
    downstream: down,
    operator: operator.value,
    version: Number(row.__version ?? 0),
  })
  flash(result.ok, result.message)
  reload()
}

function editLimit(limit: OpeningLimit) {
  limitForm.gate = limit.gate
  limitForm.canal = limit.canal
  limitForm.min = limit.min
  limitForm.max = limit.max
  limitForm.headThreshold = limit.headThreshold
  activeTab.value = 'limits'
}

function saveLimit() {
  const result = saveOpeningLimit({
    gate: limitForm.gate,
    canal: limitForm.canal,
    min: Number(limitForm.min),
    max: Number(limitForm.max),
    headThreshold: Number(limitForm.headThreshold),
    operator: operator.value,
  })
  flash(result.ok, result.message)
  reload()
}

function clearLock(gate: string) {
  releaseLock(gate)
  reload()
}

onMounted(() => {
  initGateDomain()
  reload()
})
</script>
