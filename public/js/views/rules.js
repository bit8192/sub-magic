import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'
import { setRulesData } from '../state.js'
import { parseGeositeDat } from '../parsers/geosite.js'
import { parseGeoipDat, GEOIP_NAMES } from '../parsers/geoip.js'

export const RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-WILDCARD', 'DOMAIN-REGEX', 'GEOSITE',
  'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP',
  'SRC-GEOIP', 'SRC-IP-ASN', 'SRC-IP-CIDR', 'SRC-IP-SUFFIX',
  'DST-PORT', 'SRC-PORT',
  'IN-PORT', 'IN-TYPE', 'IN-USER', 'IN-NAME',
  'PROCESS-PATH', 'PROCESS-PATH-WILDCARD', 'PROCESS-PATH-REGEX',
  'PROCESS-NAME', 'PROCESS-NAME-WILDCARD', 'PROCESS-NAME-REGEX',
  'UID', 'NETWORK', 'DSCP',
  'RULE-SET', 'AND', 'OR', 'NOT', 'SUB-RULE', 'MATCH',
]

const COMMON_RULE_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL']
const PROXY_RULE_TYPES = ['http', 'https', 'socks4', 'socks5']
const LOGICAL_RULE_TYPES = ['AND', 'OR', 'NOT']
const LOGICAL_OPERAND_TYPES = RULE_TYPES.filter(type => type !== 'MATCH' && !LOGICAL_RULE_TYPES.includes(type))

let activeRuleFormIndex
let pendingRuleDraft = null
let ruleOptionMeta = { users: [], listeners: [] }
let ruleTargetOptions = []
let logicalPickerTargetIndex = null

async function ensureRuleOptionMeta() {
  const [users, listeners] = await Promise.all([
    API.get('/api/config/proxy-auth-users'),
    API.get('/api/config/listeners'),
  ])
  ruleOptionMeta = {
    users: Array.isArray(users) ? users : [],
    listeners: Array.isArray(listeners) ? listeners : [],
  }
}

export async function renderRules(container) {
  const data = await API.get('/api/config/rules')
  setRulesData(data)
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">规则管理</h2>
      <div><small style="color:var(--text-muted);margin-right:8px">拖拽规则可排序</small><button class="btn-primary" onclick="showRuleForm()">+ 添加</button></div>
    </div>
    <div id="rule-list">
      ${data.length ? data.map((r, i) => `
        <div class="rule-item" draggable="true" data-index="${i}" data-raw="${esc(r.raw)}">
          <div class="drag-handle">⠿</div>
          <div>
            ${r.type ? `<span class="rule-tag ${normalizeRuleTypeClass(r.type)}">${esc(r.type)}</span>` : ''}
            <span>${esc(r.raw)}</span>
          </div>
          <div class="actions">
            <button class="btn-sm btn-primary" onclick="showRuleForm(${i})">编辑</button>
            <button class="btn-sm btn-danger" onclick="deleteRule(${i})">删除</button>
          </div>
        </div>
      `).join('') : '<div class="empty">暂无规则，点击添加</div>'}
    </div>`
  attachRuleDrag()
}

function normalizeRuleTypeClass(type) {
  const lower = String(type || '').toLowerCase()
  if (lower.startsWith('domain')) return 'domain'
  if (lower.includes('geoip') || lower.includes('ip-cidr') || lower.includes('ip-suffix') || lower.includes('ip-asn')) return 'geoip'
  if (lower.includes('geosite')) return 'geosite'
  if (lower === 'match') return 'match'
  return 'domain'
}

function attachRuleDrag() {
  const list = document.getElementById('rule-list')
  if (!list) return
  let dragEl = null
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.rule-item')
    if (!item) return
    dragEl = item
    item.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.dataset.index)
  })
  list.addEventListener('dragover', e => {
    e.preventDefault()
    const item = e.target.closest('.rule-item')
    if (!item || item === dragEl) return
    const rect = item.getBoundingClientRect()
    const mid = rect.top + rect.height / 2
    if (e.clientY < mid) {
      item.parentNode.insertBefore(dragEl, item)
    } else {
      item.parentNode.insertBefore(dragEl, item.nextSibling)
    }
  })
  list.addEventListener('drop', e => {
    e.preventDefault()
    saveRuleOrder()
  })
  list.addEventListener('dragend', e => {
    const item = e.target.closest('.rule-item')
    if (item) item.classList.remove('dragging')
    dragEl = null
  })
}

async function saveRuleOrder() {
  const items = document.querySelectorAll('#rule-list .rule-item')
  const reordered = Array.from(items).map(el => el.dataset.raw)
  try {
    await API.put('/api/config/rules', { rules: reordered })
    toast('排序已保存', 'success')
    window.switchView('rules')
  } catch { toast('排序保存失败', 'error') }
}

export async function showRuleForm(index, draft = null) {
  activeRuleFormIndex = index
  logicalPickerTargetIndex = null

  let state = draft
  if (!state) {
    if (index !== undefined && index >= 0) {
      const rules = await API.get('/api/config/rules')
      state = parseRuleForForm(rules[index]?.raw || '')
    } else {
      state = defaultRuleState()
    }
  }

  const [allGroups] = await Promise.all([
    API.get('/api/config/proxy-groups'),
    ensureRuleOptionMeta(),
  ])
  const typeOptions = buildRuleTypeOptions(state.type)
  ruleTargetOptions = [...new Set([...COMMON_RULE_TARGETS, ...allGroups.map(g => g.name), state.target].filter(Boolean))]

  showModal(`
    <h3>${index !== undefined && index >= 0 ? '编辑' : '添加'}规则</h3>
    <div class="form-grid">
      <div class="form-group">
        <label>规则类型</label>
        <select id="rf-type">
          ${typeOptions.map(t => `<option value="${t}" ${t===state.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label id="rf-target-label">目标策略 / 代理组</label>
        <div id="rf-target-control"></div>
      </div>
    </div>

    <div class="form-group" id="rf-payload-group">
      <label>Payload / 条件</label>
      <div id="rf-payload-control"></div>
      <div class="form-help" id="rf-payload-help"></div>
      <div class="picker-row">
        <button id="geosite-btn" class="btn-sm btn-warning" onclick="openGeositePicker()" type="button">GeoSite</button>
        <button id="geoip-btn" class="btn-sm btn-warning" onclick="openGeoipPicker()" type="button">GeoIP</button>
      </div>
    </div>

    <div class="form-grid">
      <label class="checkbox-line" id="rf-noresolve-line">no-resolve <input type="checkbox" id="rf-noresolve" ${state.noResolve ? 'checked' : ''} /></label>
      <label class="checkbox-line" id="rf-src-line">src <input type="checkbox" id="rf-src" ${state.src ? 'checked' : ''} /></label>
      <div class="form-group">
        <label>其它附加参数</label>
        <input id="rf-extra-params" value="${esc((state.params || []).filter(p => p !== 'no-resolve' && p !== 'src').join(', '))}" placeholder="逗号分隔，例如 no-resolve、src" />
      </div>
    </div>

    <div class="form-group">
      <label>规则预览</label>
      <textarea id="rf-preview" rows="3" readonly spellcheck="false" style="font-family:var(--font-mono);font-size:12px"></textarea>
    </div>

    <div class="form-actions">
      <button class="btn-primary" onclick="saveRule(${index !== undefined && index >= 0 ? index : 'undefined'})">保存</button>
      <button onclick="cancelRuleForm()">取消</button>
    </div>
  `)

  const payloadGroup = document.getElementById('rf-payload-group')
  if (payloadGroup) payloadGroup.dataset.initialPayload = state.payload || ''
  if (payloadGroup && Array.isArray(state.logicalClauses) && state.logicalClauses.length) {
    payloadGroup.dataset.logicalDraft = JSON.stringify(state.logicalClauses)
  }
  const targetGroup = document.getElementById('rf-target-control')
  if (targetGroup) targetGroup.dataset.initialTarget = state.target || ''

  ;['rf-type', 'rf-noresolve', 'rf-src', 'rf-extra-params'].forEach(id => {
    document.getElementById(id)?.addEventListener(id === 'rf-type' ? 'change' : 'input', updateRuleFormUI)
    if (id === 'rf-noresolve' || id === 'rf-src') document.getElementById(id)?.addEventListener('change', updateRuleFormUI)
  })
  updateRuleFormUI()
}

function defaultRuleState() {
  return {
    type: 'DOMAIN-SUFFIX',
    payload: '',
    target: 'DIRECT',
    params: [],
    noResolve: false,
    src: false,
  }
}

function buildRuleTypeOptions(currentType) {
  return currentType && !RULE_TYPES.includes(currentType) ? [currentType, ...RULE_TYPES] : RULE_TYPES
}

function parseRuleForForm(raw) {
  const parts = splitRule(raw)
  const type = parts[0] || 'DOMAIN-SUFFIX'
  if (type.toUpperCase() === 'MATCH') {
    const target = parts[2] || parts[1] || ''
    const payload = parts.length >= 3 ? parts[1] : ''
    const params = (parts.length >= 3 ? parts.slice(3) : parts.slice(2)).filter(Boolean)
    return {
      type,
      payload,
      target,
      params,
      noResolve: params.includes('no-resolve'),
      src: params.includes('src'),
    }
  }
  const payload = parts[1] || ''
  const target = parts[2] || ''
  const params = parts.slice(3).filter(Boolean)
  return {
    type,
    payload,
    target,
    params,
    noResolve: params.includes('no-resolve'),
    src: params.includes('src'),
  }
}

function splitRule(raw) {
  const parts = []
  let current = ''
  let depth = 0
  for (const ch of raw || '') {
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')' && depth > 0) depth -= 1
    current += ch
  }
  if (current || String(raw || '').endsWith(',')) parts.push(current.trim())
  return parts
}

function getPayloadControlValue() {
  const logicalRows = document.querySelectorAll('.logic-clause-row')
  if (logicalRows.length) return buildLogicalPayloadFromEditor()
  const select = document.getElementById('rf-payload-select')
  if (select) return select.value.trim()
  const input = document.getElementById('rf-payload-input')
  if (input) return input.value.trim()
  return document.getElementById('rf-payload')?.value?.trim() || ''
}

function getTargetControlValue() {
  const select = document.getElementById('rf-target-select')
  if (select) return select.value.trim()
  return document.getElementById('rf-target-input')?.value?.trim() || ''
}

function renderTargetControl(type, value) {
  const container = document.getElementById('rf-target-control')
  if (!container) return

  if (type === 'SUB-RULE') {
    container.innerHTML = `<input id="rf-target-input" value="${esc(value || '')}" placeholder="输入子规则名称" />`
    container.querySelector('#rf-target-input')?.addEventListener('input', updateRuleFormUI)
    return
  }

  const options = ['<option value=""></option>']
    .concat(ruleTargetOptions.map(option => `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(option)}</option>`))
  container.innerHTML = `<select id="rf-target-select">${options.join('')}</select>`
  container.querySelector('#rf-target-select')?.addEventListener('change', updateRuleFormUI)
}

function renderPayloadControl(type, value) {
  const container = document.getElementById('rf-payload-control')
  if (!container) return

  if (LOGICAL_RULE_TYPES.includes(type)) {
    const payloadGroup = document.getElementById('rf-payload-group')
    const clauses = readLogicalDraft(payloadGroup, value)
    container.innerHTML = `
      <div class="logic-builder">
        <div class="logic-builder-tip">
          每行一个子条件，按顺序组合为当前逻辑规则。
        </div>
        <div class="logic-clause-list">
          ${clauses.map((clause, index) => renderLogicalClauseRow(clause, index, type)).join('')}
        </div>
        <div class="logic-builder-actions">
          <button type="button" class="btn-sm btn-primary" onclick="addLogicalClause()">+ 添加条件</button>
        </div>
      </div>
    `
    container.querySelectorAll('.logic-clause-type').forEach(el => el.addEventListener('change', handleLogicalClauseTypeChange))
    container.querySelectorAll('.logic-clause-value').forEach(el => el.addEventListener('input', handleLogicalClauseValueInput))
    return
  }

  if (type === 'IN-USER') {
    const options = ['<option value=""></option>']
      .concat(ruleOptionMeta.users.map(user => `<option value="${esc(user.username)}"${user.username === value ? ' selected' : ''}>${esc(user.username)}</option>`))
    container.innerHTML = `<select id="rf-payload-select">${options.join('')}</select>`
    container.querySelector('#rf-payload-select')?.addEventListener('change', updateRuleFormUI)
    return
  }

  if (type === 'IN-TYPE') {
    const options = ['<option value=""></option>']
      .concat(PROXY_RULE_TYPES.map(item => `<option value="${item}"${item === value ? ' selected' : ''}>${item}</option>`))
    container.innerHTML = `<select id="rf-payload-select">${options.join('')}</select>`
    container.querySelector('#rf-payload-select')?.addEventListener('change', updateRuleFormUI)
    return
  }

  if (type === 'IN-NAME') {
    const options = ['<option value=""></option>']
      .concat(ruleOptionMeta.listeners.map(listener => `<option value="${esc(listener.name)}"${listener.name === value ? ' selected' : ''}>${esc(listener.name)} · ${esc(listener.type || '')}</option>`))
    container.innerHTML = `<select id="rf-payload-select">${options.join('')}</select>`
    container.querySelector('#rf-payload-select')?.addEventListener('change', updateRuleFormUI)
    return
  }

  if (type === 'IN-PORT') {
    const datalistId = 'rf-payload-port-options'
    const portOptions = [...new Set(ruleOptionMeta.listeners.map(listener => String(listener.port || '').trim()).filter(Boolean))]
    container.innerHTML = `
      <input id="rf-payload-input" list="${datalistId}" value="${esc(value || '')}" placeholder="例如 7890" />
      <datalist id="${datalistId}">
        ${portOptions.map(option => `<option value="${esc(option)}"></option>`).join('')}
      </datalist>
    `
    container.querySelector('#rf-payload-input')?.addEventListener('input', updateRuleFormUI)
    return
  }

  container.innerHTML = `<textarea id="rf-payload" rows="3" placeholder="例如 google.com、CN、80、((DOMAIN,baidu.com),(NETWORK,UDP))">${esc(value || '')}</textarea>`
  container.querySelector('#rf-payload')?.addEventListener('input', updateRuleFormUI)
}

function renderLogicalClauseRow(clause, index, parentType) {
  const normalizedType = LOGICAL_OPERAND_TYPES.includes(clause.type) ? clause.type : 'DOMAIN'
  const normalizedValue = LOGICAL_OPERAND_TYPES.includes(clause.type) ? clause.value : ''
  const typeOptions = LOGICAL_OPERAND_TYPES.map(option =>
    `<option value="${option}"${option === normalizedType ? ' selected' : ''}>${option}</option>`
  ).join('')
  const removeDisabled = parentType === 'NOT'
  const pickerButton = normalizedType === 'GEOSITE'
    ? `<button type="button" class="btn-sm btn-warning" onclick="openLogicalGeositePicker(${index})">GeoSite</button>`
    : normalizedType === 'GEOIP'
      ? `<button type="button" class="btn-sm btn-warning" onclick="openLogicalGeoipPicker(${index})">GeoIP</button>`
      : ''
  return `
    <div class="logic-clause-row">
      <div class="logic-clause-main">
        <select class="logic-clause-type" data-index="${index}">
          ${typeOptions}
        </select>
        <input
          class="logic-clause-value"
          data-index="${index}"
          value="${esc(normalizedValue || '')}"
          placeholder="${esc(getLogicalClausePlaceholder(normalizedType))}"
        />
        <button
          type="button"
          class="btn-sm btn-danger"
          onclick="removeLogicalClause(${index})"
          ${removeDisabled ? 'disabled' : ''}
        >删除</button>
      </div>
      ${pickerButton ? `<div class="logic-clause-picker-row">${pickerButton}</div>` : ''}
      <div class="form-help logic-clause-help">${esc(getLogicalClauseHint(normalizedType))}</div>
    </div>
  `
}

function getLogicalClausePlaceholder(type) {
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
      return '例如 google.com'
    case 'DOMAIN-KEYWORD':
      return '例如 google'
    case 'DOMAIN-WILDCARD':
      return '例如 *.google.com'
    case 'DOMAIN-REGEX':
      return '例如 ^abc.*com'
    case 'GEOSITE':
      return '例如 youtube'
    case 'GEOIP':
    case 'SRC-GEOIP':
      return '例如 CN'
    case 'IP-CIDR':
    case 'SRC-IP-CIDR':
      return '例如 192.168.1.0/24'
    case 'NETWORK':
      return '例如 UDP'
    case 'DST-PORT':
    case 'SRC-PORT':
    case 'IN-PORT':
      return '例如 443'
    default:
      return '输入该条件的 payload'
  }
}

function getLogicalClauseHint(type) {
  return `将生成 (${type},payload) 形式的子条件。`
}

function stripOuterParens(raw) {
  const value = String(raw || '').trim()
  if (!value.startsWith('(') || !value.endsWith(')')) return value
  let depth = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth === 0 && i < value.length - 1) return value
  }
  return value.slice(1, -1).trim()
}

function parseLogicalClause(rawClause) {
  const clause = stripOuterParens(rawClause)
  const parts = splitRule(clause)
  const type = parts[0] || 'DOMAIN'
  if (!LOGICAL_OPERAND_TYPES.includes(type)) {
    return { type: 'DOMAIN', value: '' }
  }
  return {
    type,
    value: parts.slice(1).join(',').trim(),
  }
}

function defaultLogicalClause() {
  return { type: 'DOMAIN', value: '' }
}

function parseLogicalPayload(payload) {
  const normalized = String(payload || '').trim()
  if (!normalized) return [defaultLogicalClause()]
  const inner = stripOuterParens(normalized)
  const clauses = splitRule(inner).map(parseLogicalClause).filter(clause => clause.type || clause.value)
  return clauses.length ? clauses : [defaultLogicalClause()]
}

function serializeLogicalClause(clause) {
  const type = String(clause?.type || '').trim()
  const value = String(clause?.value || '').trim()
  if (!type && !value) return ''
  if (!value) return ''
  return `(${type},${value})`
}

function serializeLogicalClauses(clauses) {
  const parts = clauses.map(serializeLogicalClause).filter(Boolean)
  return parts.length ? `(${parts.join(',')})` : ''
}

function readLogicalClausesFromEditor() {
  const rows = document.querySelectorAll('.logic-clause-row')
  return Array.from(rows).map(row => ({
    type: row.querySelector('.logic-clause-type')?.value || 'DOMAIN',
    value: row.querySelector('.logic-clause-value')?.value || '',
  }))
}

function buildLogicalPayloadFromEditor() {
  return serializeLogicalClauses(readLogicalClausesFromEditor())
}

function saveLogicalDraft(clauses) {
  const payloadGroup = document.getElementById('rf-payload-group')
  if (payloadGroup) payloadGroup.dataset.logicalDraft = JSON.stringify(clauses)
}

function clearLogicalDraft() {
  const payloadGroup = document.getElementById('rf-payload-group')
  if (payloadGroup) delete payloadGroup.dataset.logicalDraft
}

function readLogicalDraft(payloadGroup, fallbackPayload = '') {
  const draft = payloadGroup?.dataset.logicalDraft
  if (draft) {
    try {
      const parsed = JSON.parse(draft)
      if (Array.isArray(parsed) && parsed.length) return parsed
    } catch {
      /* ignore invalid draft */
    }
  }
  return parseLogicalPayload(fallbackPayload)
}

function applyLogicalPayloadAndRefresh(clauses) {
  const payload = serializeLogicalClauses(clauses)
  const payloadGroup = document.getElementById('rf-payload-group')
  const payloadControl = document.getElementById('rf-payload-control')
  if (payloadGroup) payloadGroup.dataset.initialPayload = payload
  saveLogicalDraft(clauses)
  if (payloadControl) payloadControl.innerHTML = ''
  updateRuleFormUI()
}

function syncRulePreviewOnly() {
  const payloadGroup = document.getElementById('rf-payload-group')
  const targetGroup = document.getElementById('rf-target-control')
  if (payloadGroup && document.querySelectorAll('.logic-clause-row').length) {
    saveLogicalDraft(readLogicalClausesFromEditor())
  }
  if (payloadGroup) payloadGroup.dataset.initialPayload = getPayloadControlValue()
  if (targetGroup) targetGroup.dataset.initialTarget = getTargetControlValue()
  const preview = document.getElementById('rf-preview')
  if (preview) preview.value = buildRulePreview()
}

function handleLogicalClauseTypeChange() {
  syncRulePreviewOnly()
  updateRuleFormUI()
}

function handleLogicalClauseValueInput() {
  syncRulePreviewOnly()
}

function buildRulePreview() {
  const type = document.getElementById('rf-type')?.value || ''
  const payload = getPayloadControlValue()
  const target = getTargetControlValue()
  const extras = new Set(
    (document.getElementById('rf-extra-params')?.value || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  )
  if (document.getElementById('rf-noresolve')?.checked) extras.add('no-resolve')
  if (document.getElementById('rf-src')?.checked) extras.add('src')

  const parts = [type]
  if (type.toUpperCase() === 'MATCH' && !payload) {
    parts.push(target)
  } else {
    parts.push(payload, target)
  }
  if (extras.size) parts.push(...extras)
  return parts.join(',')
}

function getRuleTypeHint(type) {
  switch (type) {
    case 'MATCH':
      return '匹配所有请求，通常只需要填写目标策略。'
    case 'RULE-SET':
      return 'payload 填 rule-provider 名称，目标填策略或代理组。'
    case 'AND':
    case 'OR':
    case 'NOT':
      return '使用下方条件编辑器组合子条件。'
    case 'SUB-RULE':
      return 'payload 例如 (NETWORK,tcp)，目标填 sub-rule 名称。'
    case 'GEOSITE':
      return 'payload 为 geosite 分类名，可用右侧按钮挑选。'
    case 'GEOIP':
      return 'payload 为国家/地区代码，如 CN、US。'
    case 'NETWORK':
      return 'payload 使用 tcp 或 udp。'
    case 'IN-USER':
      return 'payload 为代理授权用户，可从下拉中选择，也可留空表示未认证。'
    case 'IN-TYPE':
      return 'payload 为代理方式，可选 http / https / socks4 / socks5。'
    case 'IN-NAME':
      return 'payload 为 listener 名称，可从当前 listeners 配置中选择。'
    case 'IN-PORT':
      return 'payload 为入口端口，可直接填写，也可使用 listeners 端口建议。'
    default:
      return '按 Mihomo 规则语法填写 payload 和目标。'
  }
}

export function updateRuleFormUI() {
  const type = document.getElementById('rf-type')?.value || ''
  const payloadGroup = document.getElementById('rf-payload-group')
  const targetGroup = document.getElementById('rf-target-control')
  const payloadHelp = document.getElementById('rf-payload-help')
  const currentPayload = getPayloadControlValue() || payloadGroup?.dataset.initialPayload || ''
  const currentTarget = getTargetControlValue() || targetGroup?.dataset.initialTarget || ''
  const targetLabel = document.getElementById('rf-target-label')
  const geositeBtn = document.getElementById('geosite-btn')
  const geoipBtn = document.getElementById('geoip-btn')
  const noResolveLine = document.getElementById('rf-noresolve-line')
  const srcLine = document.getElementById('rf-src-line')

  const payloadOptional = type.toUpperCase() === 'MATCH'
  if (!LOGICAL_RULE_TYPES.includes(type)) clearLogicalDraft()
  payloadGroup.style.display = ''
  payloadHelp.textContent = getRuleTypeHint(type)
  renderPayloadControl(type, currentPayload)
  if (payloadGroup) payloadGroup.dataset.initialPayload = currentPayload
  renderTargetControl(type, currentTarget)
  if (targetGroup) targetGroup.dataset.initialTarget = currentTarget
  const payload = document.getElementById('rf-payload') || document.getElementById('rf-payload-input') || document.getElementById('rf-payload-select')
  if (payload && type.toUpperCase() === 'MATCH' && 'placeholder' in payload) payload.placeholder = 'MATCH 可留空'
  targetLabel.textContent = type === 'SUB-RULE' ? '子规则名称' : '目标策略 / 代理组'
  geositeBtn.style.display = type === 'GEOSITE' ? 'inline-flex' : 'none'
  geoipBtn.style.display = type === 'GEOIP' ? 'inline-flex' : 'none'
  const ipLike = ['IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP'].includes(type)
  noResolveLine.style.display = ipLike ? 'flex' : 'none'
  srcLine.style.display = ipLike ? 'flex' : 'none'
  if (!ipLike) {
    document.getElementById('rf-noresolve').checked = false
    document.getElementById('rf-src').checked = false
  }
  if (payloadOptional && payload && 'value' in payload && !payload.value.trim()) {
    payload.value = ''
  }
  document.getElementById('rf-preview').value = buildRulePreview()
}

export function togglePickerBtns() { updateRuleFormUI() }
export function toggleGeoSiteBtn() { updateRuleFormUI() }

export function addLogicalClause() {
  const type = document.getElementById('rf-type')?.value || 'AND'
  const clauses = readLogicalClausesFromEditor()
  if (type === 'NOT' && clauses.length >= 1) {
    toast('NOT 规则只支持一个子条件', 'warning')
    return
  }
  clauses.push(defaultLogicalClause())
  applyLogicalPayloadAndRefresh(clauses)
}

export function removeLogicalClause(index) {
  const type = document.getElementById('rf-type')?.value || 'AND'
  let clauses = readLogicalClausesFromEditor().filter((_, i) => i !== index)
  if (!clauses.length) clauses = [defaultLogicalClause()]
  if (type === 'NOT' && clauses.length > 1) clauses = [clauses[0]]
  applyLogicalPayloadAndRefresh(clauses)
}

function updateLogicalClauseValue(index, nextType, nextValue, sourceClauses = null) {
  const clauses = Array.isArray(sourceClauses) ? sourceClauses.map(clause => ({ ...clause })) : readLogicalClausesFromEditor()
  if (!clauses[index]) return
  clauses[index] = {
    ...clauses[index],
    type: nextType ?? clauses[index].type,
    value: nextValue ?? clauses[index].value,
  }
  if (sourceClauses) {
    const payload = serializeLogicalClauses(clauses)
    const draft = pendingRuleDraft || defaultRuleState()
    draft.payload = payload
    draft.logicalClauses = clauses
    pendingRuleDraft = draft
    return
  }
  applyLogicalPayloadAndRefresh(clauses)
}

export function openLogicalGeositePicker(index) {
  logicalPickerTargetIndex = index
  openGeositePicker()
}

export function openLogicalGeoipPicker(index) {
  logicalPickerTargetIndex = index
  openGeoipPicker()
}

export function cancelRuleForm() {
  closeModal()
  pendingRuleDraft = null
  logicalPickerTargetIndex = null
  if (document.getElementById('gs-list') || document.getElementById('gi-list')) {
    window.switchView('rules')
  }
}

function captureRuleDraft() {
  const logicalClauses = document.querySelectorAll('.logic-clause-row').length
    ? readLogicalClausesFromEditor()
    : undefined
  return {
    index: activeRuleFormIndex,
    type: document.getElementById('rf-type')?.value || 'GEOSITE',
    payload: getPayloadControlValue(),
    logicalClauses,
    target: getTargetControlValue(),
    params: (document.getElementById('rf-extra-params')?.value || '').split(',').map(v => v.trim()).filter(Boolean),
    noResolve: !!document.getElementById('rf-noresolve')?.checked,
    src: !!document.getElementById('rf-src')?.checked,
  }
}

/* ============ GeoSite Picker ============ */
export async function openGeositePicker() {
  pendingRuleDraft = captureRuleDraft()
  try {
    const GEOX_URL = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat'
    toast('正在浏览器端解析 geosite.dat...')
    const res = await fetch(GEOX_URL)
    if (!res.ok) { toast('下载 geosite.dat 失败', 'error'); return }
    const bytes = new Uint8Array(await res.arrayBuffer())

    const categories = parseGeositeDat(bytes)
    if (categories.length === 0) { toast('未找到分类', 'error'); return }

    closeModal()
    const container = document.getElementById('view-container')
    container.innerHTML = `
      <div class="card">
        <h2>选择 GeoSite 分类</h2>
        <div class="form-group"><input id="gs-search" placeholder="搜索分类或域名..." oninput="filterGeosite()" /></div>
        <div class="geosite-categories" id="gs-list"></div>
        <div class="form-actions" style="margin-top:16px"><button onclick="showRuleFormFromDraft()">返回规则表单</button></div>
      </div>`
    window._geositeCategories = categories
    filterGeosite()
  } catch { toast('获取 geosite 数据失败', 'error') }
}

export function filterGeosite() {
  const q = document.getElementById('gs-search').value.trim()
  const categories = window._geositeCategories || []
  const ql = q.toLowerCase()
  const list = document.getElementById('gs-list')
  if (!categories.length) { list.innerHTML = '<div class="empty">无匹配</div>'; return }
  const maxDomains = 200
  let html = ''
  for (const c of categories) {
    const nameMatch = !q || c.name.toLowerCase().includes(ql)
    const matchedDomains = q ? c.domains.filter(d => d.toLowerCase().includes(ql)) : []
    if (q && !nameMatch && matchedDomains.length === 0) continue
    const autoExpand = !!(q && (nameMatch || matchedDomains.length > 0))
    const domains = !q ? c.domains : (nameMatch ? c.domains : matchedDomains)
    const show = domains.slice(0, maxDomains)
    const remain = domains.length - maxDomains
    html += `<div class="gs-category ${autoExpand ? 'open' : ''}">
      <div class="gs-category-header">
        <span class="gs-category-name" onclick="selectGeosite('${esc(c.name)}')">${esc(c.name)}</span>
        <span class="gs-domain-count">${c.domains.length}</span>
        <span class="gs-arrow" onclick="event.stopPropagation();toggleGeositeCategory(this)">▶</span>
      </div>
      <div class="gs-domain-list">${
        show.map(d => `<span class="gs-domain">${esc(d)}</span>`).join('')
      }${remain > 0 ? `<div class="gs-more">... 还有 ${remain} 个域名</div>` : ''}</div>
    </div>`
  }
  list.innerHTML = html || '<div class="empty">无匹配</div>'
}

export function toggleGeositeCategory(el) {
  el.closest('.gs-category').classList.toggle('open')
}

export async function selectGeosite(category) {
  if (logicalPickerTargetIndex !== null) {
    const draft = pendingRuleDraft || defaultRuleState()
    const clauses = Array.isArray(draft.logicalClauses) && draft.logicalClauses.length
      ? draft.logicalClauses
      : parseLogicalPayload(draft.payload)
    updateLogicalClauseValue(logicalPickerTargetIndex, 'GEOSITE', category, clauses)
    logicalPickerTargetIndex = null
    await showRuleFormFromDraft()
    return
  }
  const draft = pendingRuleDraft || defaultRuleState()
  draft.type = 'GEOSITE'
  draft.payload = category
  pendingRuleDraft = draft
  closeModal()
  await showRuleFormFromDraft()
}

/* ============ GeoIP Picker ============ */
export async function openGeoipPicker() {
  pendingRuleDraft = captureRuleDraft()
  try {
    const GEOIP_URL = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat'
    toast('正在浏览器端解析 geoip.dat...')
    const res = await fetch(GEOIP_URL)
    if (!res.ok) { toast('下载 geoip.dat 失败', 'error'); return }
    const bytes = new Uint8Array(await res.arrayBuffer())

    const countries = parseGeoipDat(bytes)
    if (countries.length === 0) { toast('未找到 GeoIP 条目', 'error'); return }

    closeModal()
    const container = document.getElementById('view-container')
    container.innerHTML = `
      <div class="card">
        <h2>选择 GeoIP 国家/地区</h2>
        <div class="form-group"><input id="gi-search" placeholder="搜索 (如 CN, US, JP)..." oninput="filterGeoip()" /></div>
        <div class="geosite-categories" id="gi-list"></div>
        <div class="form-actions" style="margin-top:16px"><button onclick="showRuleFormFromDraft()">返回规则表单</button></div>
      </div>`
    window._geoipCountries = countries
    filterGeoip()
  } catch { toast('获取 GeoIP 数据失败', 'error') }
}

export function filterGeoip() {
  const q = document.getElementById('gi-search').value.trim()
  const countries = window._geoipCountries || []
  const ql = q.toLowerCase()
  const list = document.getElementById('gi-list')
  if (!countries.length) { list.innerHTML = '<div class="empty">无匹配</div>'; return }

  const filtered = q ? countries.filter(c =>
    c.code.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql)
  ) : countries

  list.innerHTML = filtered.length
    ? filtered.map(c => `<div class="gs-category-header" style="cursor:pointer;padding:8px 12px;border-radius:4px" onclick="selectGeoip('${esc(c.code)}')">
        <span class="gs-category-name">${esc(c.code)}</span>
        <span style="color:var(--text-muted);font-size:12px;margin-left:8px">${esc(c.name || GEOIP_NAMES[c.code] || c.code)}</span>
      </div>`).join('')
    : '<div class="empty">无匹配</div>'
}

export async function selectGeoip(country) {
  if (logicalPickerTargetIndex !== null) {
    const draft = pendingRuleDraft || defaultRuleState()
    const clauses = Array.isArray(draft.logicalClauses) && draft.logicalClauses.length
      ? draft.logicalClauses
      : parseLogicalPayload(draft.payload)
    updateLogicalClauseValue(logicalPickerTargetIndex, 'GEOIP', country, clauses)
    logicalPickerTargetIndex = null
    await showRuleFormFromDraft()
    return
  }
  const draft = pendingRuleDraft || defaultRuleState()
  draft.type = 'GEOIP'
  draft.payload = country
  pendingRuleDraft = draft
  closeModal()
  await showRuleFormFromDraft()
}

export async function showRuleFormFromDraft() {
  const draft = pendingRuleDraft || defaultRuleState()
  const index = draft.index
  pendingRuleDraft = null
  return showRuleForm(index, draft)
}

export async function saveRule(index) {
  const raw = buildRulePreview()
  const type = document.getElementById('rf-type').value.trim()
  const target = getTargetControlValue()
  const payload = getPayloadControlValue()
  if (!type) { toast('规则类型不能为空', 'error'); return }
  if (!target) { toast('目标策略不能为空', 'error'); return }
  if (type.toUpperCase() !== 'MATCH' && !payload) { toast('payload 不能为空', 'error'); return }
  if (type === 'NOT' && parseLogicalPayload(payload).filter(clause => serializeLogicalClause(clause)).length !== 1) {
    toast('NOT 规则必须且只能有一个有效子条件', 'error')
    return
  }
  try {
    if (index !== undefined && index >= 0) {
      await API.put(`/api/config/rules/${index}`, { raw })
    } else {
      await API.post('/api/config/rules', { raw })
    }
    closeModal()
    toast('已保存', 'success')
    window.switchView('rules')
  } catch { toast('保存失败', 'error') }
}

export async function deleteRule(index) {
  if (!confirm('删除此规则？')) return
  await API.del(`/api/config/rules/${index}`)
  toast('已删除', 'success')
  window.switchView('rules')
}
