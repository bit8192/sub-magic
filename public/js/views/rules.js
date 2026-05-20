import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'
import { rulesData as _rulesData, setRulesData } from '../state.js'
import { parseGeositeDat } from '../parsers/geosite.js'
import { parseGeoipDat, GEOIP_NAMES } from '../parsers/geoip.js'

export const RULE_TYPES = ['MATCH', 'GEOIP', 'GEOSITE', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'SRC-IP-CIDR', 'DST-PORT', 'SRC-PORT', 'PROCESS-NAME']

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
            ${r.type ? `<span class="rule-tag ${r.type.toLowerCase()}">${esc(r.type)}</span>` : ''}
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

export async function showRuleForm(index) {
  let raw = ''
  if (index !== undefined && index >= 0) {
    const rules = await API.get('/api/config/rules')
    raw = rules[index]?.raw || ''
  }
  const parts = raw ? raw.split(',').map(s => s.trim()) : []
  const type = parts[0] || 'MATCH'
  const payload = parts[1] || ''
  const proxy = parts[2] || ''
  const noResolve = raw.includes('no-resolve')

  const allGroups = await API.get('/api/config/proxy-groups')
  const proxyOptions = ['DIRECT', ...allGroups.map(g => g.name)]
  if (proxy && !proxyOptions.includes(proxy)) proxyOptions.unshift(proxy)

  showModal(`
    <h3>${index !== undefined && index >= 0 ? '编辑' : '添加'}规则</h3>
    <div class="form-group">
      <label>规则类型</label>
       <select id="rf-type" onchange="togglePickerBtns()">
        ${RULE_TYPES.map(t => `<option value="${t}" ${type===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>参数 (payload)</label>
      <div style="display:flex;gap:8px">
        <input id="rf-payload" value="${esc(payload)}" style="flex:1" />
        <button id="geosite-btn" class="btn-sm btn-warning" onclick="openGeositePicker()" style="display:${type==='GEOSITE'?'block':'none'}">GeoSite</button>
        <button id="geoip-btn" class="btn-sm btn-warning" onclick="openGeoipPicker()" style="display:${type==='GEOIP'?'block':'none'}">GeoIP</button>
      </div>
    </div>
    <div class="form-group"><label>代理组</label><select id="rf-proxy">${proxyOptions.map(o => `<option value="${esc(o)}" ${proxy===o?'selected':''}>${esc(o)}</option>`).join('')}</select></div>
    <div class="form-group">
      <label for="rf-noresolve" style="white-space: nowrap">
        no-resolve
        <input type="checkbox" id="rf-noresolve" ${noResolve?'checked':''} />
      </label>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="saveRule(${index !== undefined && index >= 0 ? index : 'undefined'})">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  `)
}

export function togglePickerBtns() {
  const type = document.getElementById('rf-type').value
  const gsBtn = document.getElementById('geosite-btn')
  const giBtn = document.getElementById('geoip-btn')
  if (gsBtn) gsBtn.style.display = type === 'GEOSITE' ? 'block' : 'none'
  if (giBtn) giBtn.style.display = type === 'GEOIP' ? 'block' : 'none'
}

export function toggleGeoSiteBtn() { togglePickerBtns() }

/* ============ GeoSite Picker ============ */
export async function openGeositePicker() {
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
        <div class="form-actions" style="margin-top:16px"><button onclick="switchView('rules')">返回</button></div>
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
  closeModal()
  await showRuleForm(-1)
  document.getElementById('rf-type').value = 'GEOSITE'
  document.getElementById('rf-payload').value = category
  toggleGeoSiteBtn()
}

/* ============ GeoIP Picker ============ */
export async function openGeoipPicker() {
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
        <div class="form-actions" style="margin-top:16px"><button onclick="switchView('rules')">返回</button></div>
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
        <span style="color:var(--text-muted);font-size:12px;margin-left:8px">${esc(c.name)}</span>
      </div>`).join('')
    : '<div class="empty">无匹配</div>'
}

export async function selectGeoip(country) {
  closeModal()
  await showRuleForm(-1)
  document.getElementById('rf-type').value = 'GEOIP'
  document.getElementById('rf-payload').value = country
  togglePickerBtns()
}

export async function saveRule(index) {
  const type = document.getElementById('rf-type').value
  const payload = document.getElementById('rf-payload').value
  const proxy = document.getElementById('rf-proxy').value
  const noResolve = document.getElementById('rf-noresolve').checked
  const raw = noResolve ? `${type},${payload},${proxy},no-resolve` : `${type},${payload},${proxy}`
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
