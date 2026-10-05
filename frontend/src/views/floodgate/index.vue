<template>
  <section class="page" data-module="floodgate">
    <header class="page-head">
      <div>
        <h2>闸门调度管理</h2>
        <p class="page-desc">
          按闸门名称与所属河渠设定开度口径：区间外的单子不许提交并写清超出多少；水位差超阈值先观察一轮再开；
          同一道闸同一时段只留一条待执行，重复下发旧单自动作废留痕；终止结论直落内涝处置待派队清单。
        </p>
      </div>
      <div class="page-actions">
        <label class="operator-item">
          <span>当前操作人</span>
          <input v-model="operatorName" @change="applyOperator" />
        </label>
        <button class="btn primary" type="button" @click="openCreate">下发调度单</button>
        <button class="btn" type="button" @click="openRules">开度口径</button>
        <button class="btn" type="button" @click="openAudit('')">开度改动记录</button>
        <button class="btn" type="button" @click="exportRows">导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>调度编号</th>
          <th>闸门名称</th>
          <th>所属河渠</th>
          <th>调度时段</th>
          <th>闸门开度</th>
          <th>水位（上/下）</th>
          <th>水位差</th>
          <th>观察</th>
          <th>调度人</th>
          <th>当前状态</th>
          <th>备注</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row.调度编号 }}</td>
          <td>{{ row.闸门名称 }}</td>
          <td>{{ row.所属河渠 }}</td>
          <td>{{ row.调度时段 }}</td>
          <td>
            {{ formatOpening(row.闸门开度) }}
            <div class="mini">{{ ruleLabel(row) }}</div>
          </td>
          <td>{{ row.上游水位 }} / {{ row.下游水位 }}</td>
          <td :class="{ 'warn-text': diffOver(row) }">{{ waterDiff(row) }}</td>
          <td>{{ row.观察记录 ?? '未观察' }}</td>
          <td>{{ row.调度人 }}</td>
          <td>{{ row.status }}</td>
          <td class="mini">{{ noteOf(row) }}</td>
          <td class="row-actions">
            <template v-if="row.status === '待调度'">
              <button class="link" type="button" @click="doSubmit(row)">提交调度</button>
              <button class="link" type="button" @click="openObserve(row)">登记观察</button>
              <button class="link" type="button" @click="openOpening(row)">调整开度</button>
            </template>
            <template v-else-if="row.status === '执行中'">
              <button class="link" type="button" @click="openOpening(row)">调整开度</button>
              <button class="link" type="button" @click="openTerminate(row)">终止调度</button>
            </template>
            <button class="link" type="button" @click="openAudit(String(row.调度编号))">留痕</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="12" class="empty-state">暂无闸门调度数据，可先下发调度单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条闸门调度记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog === 'create'" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog">
        <h3>下发调度单</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>闸门名称</span>
            <select v-model="createForm.闸门名称" @change="syncRiver">
              <option value="" disabled>请选择闸门</option>
              <option v-for="rule in rules" :key="rule.id" :value="rule.闸门名称">
                {{ rule.闸门名称 }}（{{ rule.所属河渠 }}）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>所属河渠</span>
            <input v-model="createForm.所属河渠" readonly />
          </label>
          <label class="form-item">
            <span>调度时段</span>
            <input v-model="createForm.调度时段" placeholder="如 2026-10-05 08:00-12:00" />
          </label>
          <label class="form-item">
            <span>闸门开度（m）</span>
            <input v-model="createForm.闸门开度" type="number" step="0.1" min="0" />
          </label>
          <label class="form-item">
            <span>上游水位（m）</span>
            <input v-model="createForm.上游水位" type="number" step="0.01" />
          </label>
          <label class="form-item">
            <span>下游水位（m）</span>
            <input v-model="createForm.下游水位" type="number" step="0.01" />
          </label>
        </div>
        <p class="mini">{{ createRuleHint }}</p>
        <p class="mini">同一道闸同一时段重复下发时，按最新一版执行，旧单自动作废留痕。</p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">校验并下发</button>
        </div>
      </div>
    </div>

    <div v-if="dialog === 'rules'" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog wide">
        <h3>开度口径管理（按闸门名称与所属河渠分别设限）</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>闸门名称</th>
              <th>所属河渠</th>
              <th>开度下限(m)</th>
              <th>开度上限(m)</th>
              <th>水位差阈值(m)</th>
              <th>最近调整</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in rules" :key="rule.id">
              <td>{{ rule.闸门名称 }}</td>
              <td>{{ rule.所属河渠 }}</td>
              <td>{{ rule.开度下限.toFixed(2) }}</td>
              <td>{{ rule.开度上限.toFixed(2) }}</td>
              <td>{{ rule.水位差阈值.toFixed(2) }}</td>
              <td class="mini">{{ rule.更新人 }} · {{ rule.更新时间 }}</td>
              <td><button class="link" type="button" @click="editRule(rule)">调整</button></td>
            </tr>
          </tbody>
        </table>
        <h4>{{ ruleForm.id ? `调整「${ruleForm.闸门名称}」口径` : '新增口径' }}</h4>
        <div class="form-grid">
          <label class="form-item">
            <span>闸门名称</span>
            <input v-model="ruleForm.闸门名称" :readonly="ruleForm.id > 0" />
          </label>
          <label class="form-item">
            <span>所属河渠</span>
            <input v-model="ruleForm.所属河渠" :readonly="ruleForm.id > 0" />
          </label>
          <label class="form-item">
            <span>开度下限（m）</span>
            <input v-model="ruleForm.开度下限" type="number" step="0.1" min="0" />
          </label>
          <label class="form-item">
            <span>开度上限（m）</span>
            <input v-model="ruleForm.开度上限" type="number" step="0.1" min="0" />
          </label>
          <label class="form-item">
            <span>水位差阈值（m）</span>
            <input v-model="ruleForm.水位差阈值" type="number" step="0.1" min="0" />
          </label>
        </div>
        <p class="mini">保存后立刻按新口径重算所有「执行中」的调度单，落不到新区间的标异常并留痕。</p>
        <p v-if="ruleMessage" class="info-text">{{ ruleMessage }}</p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="newRule">新增口径</button>
          <button class="btn primary" type="button" @click="submitRule">保存口径并重算</button>
          <button class="btn" type="button" @click="closeDialog">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="dialog === 'audit'" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog wide">
        <h3>开度改动与调度留痕{{ auditTicket ? `（调度单 ${auditTicket}）` : '' }}</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人</th>
              <th>调度编号</th>
              <th>闸门</th>
              <th>动作</th>
              <th>旧开度</th>
              <th>新开度</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in filteredAudit" :key="entry.id">
              <td>{{ entry.时间 }}</td>
              <td>{{ entry.操作人 }}</td>
              <td>{{ entry.调度编号 }}</td>
              <td>{{ entry.闸门名称 }}</td>
              <td>{{ entry.动作 }}</td>
              <td>{{ entry.旧开度 || '—' }}</td>
              <td>{{ entry.新开度 || '—' }}</td>
              <td class="mini">{{ entry.说明 }}</td>
            </tr>
            <tr v-if="!filteredAudit.length">
              <td colspan="8" class="empty-state">暂无留痕，开度改动与调度操作都会记在这里</td>
            </tr>
          </tbody>
        </table>
        <div class="dialog-foot">
          <button v-if="auditTicket" class="btn ghost" type="button" @click="openAudit('')">查看全部</button>
          <button class="btn" type="button" @click="closeDialog">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="dialog === 'observe' && activeRow" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog">
        <h3>登记观察 — {{ activeRow.调度编号 }}</h3>
        <p class="mini">
          当前水位差 {{ waterDiff(activeRow) }}m{{ diffOver(activeRow) ? '，已超过阈值，须先观察一轮再开闸' : '，未超阈值' }}。
        </p>
        <label class="form-item">
          <span>观察结论</span>
          <textarea v-model="observeNote" rows="3" placeholder="如：观察一轮 15 分钟，上下游水位平稳，无倒灌风险"></textarea>
        </label>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitObserve">确认观察</button>
        </div>
      </div>
    </div>

    <div v-if="dialog === 'opening' && activeRow" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog">
        <h3>调整开度 — {{ activeRow.调度编号 }}</h3>
        <p class="mini">
          当前开度 {{ formatOpening(activeRow.闸门开度) }}，{{ ruleLabel(activeRow) }}；改动会留痕，谁在什么时候改成多少都能倒查。
        </p>
        <label class="form-item">
          <span>新开度（m）</span>
          <input v-model="openingValue" type="number" step="0.1" min="0" />
        </label>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitOpening">确认调整</button>
        </div>
      </div>
    </div>

    <div v-if="dialog === 'terminate' && activeRow" class="dialog-mask" @click.self="closeDialog">
      <div class="dialog">
        <h3>终止调度 — {{ activeRow.调度编号 }}</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>终止时上游水位（m）</span>
            <input v-model="terminateForm.终止时上游水位" type="number" step="0.01" />
          </label>
          <label class="form-item">
            <span>终止时下游水位（m）</span>
            <input v-model="terminateForm.终止时下游水位" type="number" step="0.01" />
          </label>
        </div>
        <label class="form-item">
          <span>终止结论</span>
          <textarea v-model="terminateForm.终止结论" rows="3" placeholder="如：上游来水回落，闸门全关，转内涝点复查"></textarea>
        </label>
        <p class="mini">终止后状态不可回退；水位读数随单存档，结论自动落入内涝处置待派队清单。</p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitTerminate">确认终止</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  adjustOpening,
  createDispatch,
  listGateAudit,
  listGateRules,
  observeDispatch,
  saveGateRule,
  submitDispatch,
  terminateDispatch,
} from '@/api/floodgate-service'
import { downloadEntries, listEntries } from '@/api/local-service'
import type { GateAudit, GateRule } from '@/data/floodgate'
import { refreshRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const MODULE = 'floodgate'
const statuses = ['待调度', '执行中', '已终止', '已作废']
const filterFields = ['调度编号', '闸门名称', '所属河渠']

const store = useSessionStore()
const operatorName = ref(store.operator)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')
const infoMessage = ref('')
const rules = ref<GateRule[]>([])
const audit = ref<GateAudit[]>([])
const auditTicket = ref('')
const dialog = ref('')
const dialogError = ref('')
const ruleMessage = ref('')
const activeRow = ref<EntryRow | null>(null)
const observeNote = ref('')
const openingValue = ref('')

const createForm = ref({ 闸门名称: '', 所属河渠: '', 调度时段: '', 闸门开度: '', 上游水位: '', 下游水位: '' })
const ruleForm = ref({ id: 0, 闸门名称: '', 所属河渠: '', 开度下限: '', 开度上限: '', 水位差阈值: '' })
const terminateForm = ref({ 终止结论: '', 终止时上游水位: '', 终止时下游水位: '' })

const stats = computed(() => [
  { label: '待调度闸门', value: countStatus('待调度') },
  { label: '执行中闸门', value: countStatus('执行中') },
  { label: '已终止调度数', value: countStatus('已终止') },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: countStatus(status),
  })),
)

const filteredAudit = computed(() =>
  auditTicket.value ? audit.value.filter((entry) => entry.调度编号 === auditTicket.value) : audit.value,
)

const createRuleHint = computed(() => {
  const rule = rules.value.find((item) => item.闸门名称 === createForm.value.闸门名称)
  if (!rule) {
    return '先选闸门，开度口径按闸门名称与所属河渠匹配'
  }
  return `口径 ${rule.开度下限.toFixed(2)}~${rule.开度上限.toFixed(2)}m，水位差阈值 ${rule.水位差阈值.toFixed(2)}m；区间外的单子不许提交`
})

function countStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function ruleOf(row: EntryRow): GateRule | undefined {
  return rules.value.find((item) => item.闸门名称 === row.闸门名称 && item.所属河渠 === row.所属河渠)
}

function ruleLabel(row: EntryRow): string {
  const rule = ruleOf(row)
  return rule ? `口径 ${rule.开度下限.toFixed(2)}~${rule.开度上限.toFixed(2)}m` : '未登记口径'
}

function formatOpening(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(2)} m` : '—'
}

function waterDiff(row: EntryRow): string {
  return Math.abs(Number(row.上游水位) - Number(row.下游水位)).toFixed(2)
}

function diffOver(row: EntryRow): boolean {
  const rule = ruleOf(row)
  return !!rule && Number(waterDiff(row)) > rule.水位差阈值
}

function noteOf(row: EntryRow): string {
  if (row.status === '已作废') {
    return String(row.作废原因 ?? '已作废')
  }
  if (row.status === '已终止') {
    return `终止：${row.终止结论 ?? ''}（水位 ${row.终止时上游水位 ?? '-'}/${row.终止时下游水位 ?? '-'}m）`
  }
  if (row.abnormal && row.口径复核) {
    return String(row.口径复核)
  }
  return ''
}

function toNumber(value: string): number | null {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

function clearMessages() {
  errorMessage.value = ''
  infoMessage.value = ''
}

function closeDialog() {
  dialog.value = ''
  dialogError.value = ''
}

function applyOperator() {
  store.setOperator(operatorName.value)
  operatorName.value = store.operator
  infoMessage.value = `当前操作人已切换为 ${store.operator}；两人同时操作同一道闸时，只认先到的那一次`
}

function defaultPeriod(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${day} ${d.getHours() < 14 ? '08:00-12:00' : '14:00-18:00'}`
}

function openCreate() {
  clearMessages()
  createForm.value = { 闸门名称: '', 所属河渠: '', 调度时段: defaultPeriod(), 闸门开度: '', 上游水位: '', 下游水位: '' }
  dialogError.value = ''
  dialog.value = 'create'
}

function syncRiver() {
  const rule = rules.value.find((item) => item.闸门名称 === createForm.value.闸门名称)
  createForm.value.所属河渠 = rule ? rule.所属河渠 : ''
}

function submitCreate() {
  dialogError.value = ''
  const opening = toNumber(createForm.value.闸门开度)
  const up = toNumber(createForm.value.上游水位)
  const down = toNumber(createForm.value.下游水位)
  if (opening === null || up === null || down === null) {
    dialogError.value = '闸门开度、上游水位、下游水位都要填数字'
    return
  }
  const result = createDispatch(
    {
      闸门名称: createForm.value.闸门名称,
      所属河渠: createForm.value.所属河渠,
      调度时段: createForm.value.调度时段,
      闸门开度: opening,
      上游水位: up,
      下游水位: down,
    },
    store.operator,
  )
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  infoMessage.value = result.message
  reload()
}

function doSubmit(row: EntryRow) {
  clearMessages()
  const result = submitDispatch(Number(row.id), store.operator, Number(row.version ?? 1))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function openObserve(row: EntryRow) {
  clearMessages()
  activeRow.value = row
  observeNote.value = ''
  dialogError.value = ''
  dialog.value = 'observe'
}

function submitObserve() {
  const row = activeRow.value
  if (!row) {
    return
  }
  const result = observeDispatch(Number(row.id), store.operator, Number(row.version ?? 1), observeNote.value.trim())
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  infoMessage.value = result.message
  reload()
}

function openOpening(row: EntryRow) {
  clearMessages()
  activeRow.value = row
  openingValue.value = String(row.闸门开度 ?? '')
  dialogError.value = ''
  dialog.value = 'opening'
}

function submitOpening() {
  const row = activeRow.value
  if (!row) {
    return
  }
  const opening = toNumber(openingValue.value)
  if (opening === null) {
    dialogError.value = '新开度要填数字'
    return
  }
  const result = adjustOpening(Number(row.id), store.operator, Number(row.version ?? 1), opening)
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  infoMessage.value = result.message
  reload()
}

function openTerminate(row: EntryRow) {
  clearMessages()
  activeRow.value = row
  terminateForm.value = {
    终止结论: '',
    终止时上游水位: String(row.上游水位 ?? ''),
    终止时下游水位: String(row.下游水位 ?? ''),
  }
  dialogError.value = ''
  dialog.value = 'terminate'
}

function submitTerminate() {
  const row = activeRow.value
  if (!row) {
    return
  }
  const up = toNumber(terminateForm.value.终止时上游水位)
  const down = toNumber(terminateForm.value.终止时下游水位)
  if (up === null || down === null) {
    dialogError.value = '终止时的水位读数要填数字，读数会随单存档'
    return
  }
  const result = terminateDispatch(Number(row.id), store.operator, Number(row.version ?? 1), {
    终止结论: terminateForm.value.终止结论,
    终止时上游水位: up,
    终止时下游水位: down,
  })
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  infoMessage.value = result.message
  reload()
}

function openRules() {
  clearMessages()
  rules.value = listGateRules()
  ruleMessage.value = ''
  dialogError.value = ''
  newRule()
  dialog.value = 'rules'
}

function editRule(rule: GateRule) {
  ruleForm.value = {
    id: rule.id,
    闸门名称: rule.闸门名称,
    所属河渠: rule.所属河渠,
    开度下限: String(rule.开度下限),
    开度上限: String(rule.开度上限),
    水位差阈值: String(rule.水位差阈值),
  }
  ruleMessage.value = ''
  dialogError.value = ''
}

function newRule() {
  ruleForm.value = { id: 0, 闸门名称: '', 所属河渠: '', 开度下限: '0.5', 开度上限: '3.0', 水位差阈值: '1.0' }
}

function submitRule() {
  dialogError.value = ''
  ruleMessage.value = ''
  const min = toNumber(ruleForm.value.开度下限)
  const max = toNumber(ruleForm.value.开度上限)
  const threshold = toNumber(ruleForm.value.水位差阈值)
  if (min === null || max === null || threshold === null) {
    dialogError.value = '开度上下限、水位差阈值都要填数字'
    return
  }
  const result = saveGateRule(
    {
      id: ruleForm.value.id,
      闸门名称: ruleForm.value.闸门名称,
      所属河渠: ruleForm.value.所属河渠,
      开度下限: min,
      开度上限: max,
      水位差阈值: threshold,
    },
    store.operator,
  )
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  rules.value = listGateRules()
  ruleMessage.value = result.message
  reload()
}

function openAudit(ticket: string) {
  clearMessages()
  auditTicket.value = ticket
  audit.value = listGateAudit()
  dialog.value = 'audit'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(MODULE)
}

function reload() {
  errorMessage.value = ''
  try {
    refreshRows()
    const payload = listEntries(MODULE, filters.value)
    rows.value = payload.items
    total.value = payload.total
    rules.value = listGateRules()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '闸门调度列表读取失败'
  }
}

onMounted(reload)
</script>
