const API = {
  async get(path) {
    const res = await fetch(path)
    if (res.status === 401) { renderLogin(); throw new Error('unauthorized') }
    return res.json()
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) { renderLogin(); throw new Error('unauthorized') }
    return res.json()
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) { renderLogin(); throw new Error('unauthorized') }
    return res.json()
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' })
    if (res.status === 401) { renderLogin(); throw new Error('unauthorized') }
    return res.json()
  },
}

function toast(msg, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

let currentView = 'dashboard'

function renderLogin() {
  currentView = 'login'
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <h1>Sub Magic</h1>
        <p>Clash 订阅管理工具</p>
        <div class="form-group">
          <label>密码</label>
          <input type="password" id="login-password" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')doLogin()" />
        </div>
        <button class="btn-primary" onclick="doLogin()" style="width:100%">登入</button>
        <div id="login-error" class="error"></div>
      </div>
    </div>`
}

async function doLogin() {
  const pwd = document.getElementById('login-password').value
  try {
    const res = await API.post('/api/login', { password: pwd })
    if (res.ok) {
      await checkAuth()
    }
  } catch {
    document.getElementById('login-error').textContent = '密码错误'
  }
}

async function checkAuth() {
  try {
    const res = await API.get('/api/check')
    if (res.ok) renderApp()
    else renderLogin()
  } catch {
    renderLogin()
  }
}

async function doLogout() {
  await API.post('/api/logout')
  renderLogin()
}

function renderApp() {
  currentView = 'dashboard'
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="topbar">
      <h1>Sub Magic</h1>
      <nav>
        <button class="active" data-view="dashboard" onclick="switchView('dashboard')">仪表盘</button>
        <button data-view="providers" onclick="switchView('providers')">订阅源</button>
        <button data-view="groups" onclick="switchView('groups')">代理组</button>
        <button data-view="rules" onclick="switchView('rules')">规则</button>
        <button data-view="editor" onclick="switchView('editor')">文本编辑</button>
        <button data-view="versions" onclick="switchView('versions')">历史版本</button>
      </nav>
      <button class="btn-logout" onclick="doLogout()">登出</button>
    </div>
    <div id="view-container"></div>`
  switchView('dashboard')
}

function switchView(view) {
  currentView = view
  document.querySelectorAll('.topbar nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view)
  })
  const container = document.getElementById('view-container')
  switch (view) {
    case 'dashboard': renderDashboard(container); break
    case 'providers': renderProviders(container); break
    case 'groups': renderGroups(container); break
    case 'rules': renderRules(container); break
    case 'editor': renderEditor(container); break
    case 'versions': renderVersions(container); break
  }
}

/* ============ Dashboard ============ */
async function renderDashboard(container) {
  const keyRes = await API.get('/api/access-key')
  const configRes = await API.get('/api/config')
  const config = configRes.config || ''
  const providerCount = (config.match(/^\s+url:/gm) || []).length
  let versionCount = 0
  try {
    const versions = await API.get('/api/config/versions')
    versionCount = versions.length
  } catch { /* ignore */ }

  container.innerHTML = `
    <div class="card">
      <h2>订阅链接</h2>
      <div class="key-display">
        <input type="text" id="sub-url" readonly value="${location.origin}/sub/${keyRes.key || ''}" />
        <button class="btn-primary" onclick="copySubUrl()">复制</button>
        <button class="btn-warning" onclick="rotateKey()">轮换 Key</button>
      </div>
    </div>
    <div class="card">
      <h2>配置概览</h2>
      <p>订阅源数: ${(config.match(/^\s+url:/gm) || []).length}</p>
      <p>代理组数: ${(config.match(/^\s+- name:/gm) || []).length}</p>
      <p>规则数: ${(config.match(/^\s+- /gm) || []).length}</p>
      <p>历史版本: ${versionCount}</p>
    </div>`
}

function copySubUrl() {
  const input = document.getElementById('sub-url')
  input.select()
  navigator.clipboard.writeText(input.value).then(() => toast('已复制', 'success'))
}

async function rotateKey() {
  if (!confirm('确定轮换订阅 Key？现有链接将立即失效。')) return
  const res = await API.post('/api/access-key/rotate')
  document.getElementById('sub-url').value = `${location.origin}/sub/${res.key}`
  toast('Key 已更新', 'success')
}

/* ============ Proxy Providers ============ */
async function renderProviders(container) {
  const providers = await API.get('/api/config/proxy-providers')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">订阅源管理</h2>
      <button class="btn-primary" onclick="showProviderForm()">+ 添加</button>
    </div>
    <div id="provider-list">
      ${providers.length ? providers.map(p => `
        <div class="provider-item">
          <div class="info">
            <div class="name">${esc(p.name)}</div>
            <div class="url">${esc(p.url || '')} · ${p.type || 'http'} · 间隔 ${p.interval || 86400}s</div>
          </div>
          <div class="actions">
            <button class="btn-sm btn-primary" onclick="showProviderForm('${esc(p.name)}')">编辑</button>
            <button class="btn-sm btn-danger" onclick="deleteProvider('${esc(p.name)}')">删除</button>
          </div>
        </div>
      `).join('') : '<div class="empty">暂无订阅源</div>'}
    </div>`
}

async function showProviderForm(name) {
  let provider = { name: '', url: '', type: 'http', interval: 86400, 'health-check': { enable: true, url: 'https://www.gstatic.com/generate_204', interval: 300 }, override: {} }
  if (name) {
    const list = await API.get('/api/config/proxy-providers')
    provider = list.find(p => p.name === name) || provider
  }
  showModal(`
    <h3>${name ? '编辑' : '添加'}订阅源</h3>
    <div class="form-group"><label>名称</label><input id="pf-name" value="${esc(provider.name)}" ${name ? 'readonly' : ''} /></div>
    <div class="form-group"><label>订阅 URL</label><input id="pf-url" value="${esc(provider.url || '')}" /></div>
    <div class="form-row">
      <div class="form-group"><label>类型</label><select id="pf-type"><option value="http" ${provider.type === 'http' ? 'selected' : ''}>HTTP</option></select></div>
      <div class="form-group"><label>更新间隔 (秒)</label><input id="pf-interval" type="number" value="${provider.interval || 86400}" /></div>
    </div>
    <div class="form-group"><label>健康检查 URL</label><input id="pf-hc-url" value="${esc(provider['health-check']?.url || '')}" /></div>
    <div class="form-row">
      <div class="form-group"><label>健康检查间隔 (秒)</label><input id="pf-hc-interval" type="number" value="${provider['health-check']?.interval || 300}" /></div>
      <div class="form-group"><label>前缀</label><input id="pf-prefix" value="${esc(provider.override?.['additional-prefix'] || '')}" placeholder="[provider1]" /></div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="saveProvider('${esc(provider.name)}')">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  `)
}

async function saveProvider(oldName) {
  const data = {
    name: document.getElementById('pf-name').value,
    url: document.getElementById('pf-url').value,
    type: document.getElementById('pf-type').value,
    interval: parseInt(document.getElementById('pf-interval').value) || 86400,
    'health-check': {
      enable: true,
      url: document.getElementById('pf-hc-url').value || 'https://www.gstatic.com/generate_204',
      interval: parseInt(document.getElementById('pf-hc-interval').value) || 300,
    },
    override: { 'additional-prefix': document.getElementById('pf-prefix').value || '' },
  }
  try {
    if (oldName) {
      await API.put(`/api/config/proxy-providers/${encodeURIComponent(oldName)}`, data)
    } else {
      await API.post('/api/config/proxy-providers', data)
    }
    closeModal()
    toast('已保存', 'success')
    switchView('providers')
  } catch (e) { toast('保存失败', 'error') }
}

async function deleteProvider(name) {
  if (!confirm(`删除订阅源 "${name}"？`)) return
  await API.del(`/api/config/proxy-providers/${encodeURIComponent(name)}`)
  toast('已删除', 'success')
  switchView('providers')
}

/* ============ Proxy Groups ============ */
let _groupsData = []
let _msAvailable = []
let _msSelected = new Set()

async function renderGroups(container) {
  _groupsData = await API.get('/api/config/proxy-groups')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">代理组管理</h2>
      <div><small style="color:var(--text-muted);margin-right:8px">拖拽代理可排序</small><button class="btn-primary" onclick="showGroupForm()">+ 添加</button></div>
    </div>
    <div id="group-list">
      ${_groupsData.length ? _groupsData.map(g => `
        <div class="group-card" data-group="${esc(g.name)}">
          <div class="header">
            <div><span class="name">${esc(g.name)}</span> <span class="type">${g.type}</span></div>
            <div class="actions">
              <button class="btn-sm btn-primary" onclick="showGroupForm('${esc(g.name)}')">编辑</button>
              <button class="btn-sm btn-danger" onclick="deleteGroup('${esc(g.name)}')">删除</button>
            </div>
          </div>
          <div class="proxies">${(g.proxies || []).map((p, pi) => `<span class="proxy-tag" draggable="true" data-proxy-index="${pi}" data-group="${esc(g.name)}">${esc(p)}</span>`).join('')}</div>
          ${g.filter ? `<div style="margin-top:4px;font-size:12px;color:var(--text-muted)">filter: ${esc(g.filter)}</div>` : ''}
          ${g['include-all'] ? '<div style="margin-top:4px;font-size:12px;color:var(--text-muted)">include-all: true</div>' : ''}
        </div>
      `).join('') : '<div class="empty">暂无代理组</div>'}
    </div>`
  attachProxyDrag()
}

function attachProxyDrag() {
  const list = document.getElementById('group-list')
  if (!list) return
  list.addEventListener('dragstart', e => {
    const tag = e.target.closest('.proxy-tag')
    if (!tag) return
    tag.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({
      group: tag.dataset.group,
      index: parseInt(tag.dataset.proxyIndex),
    }))
  })
  list.addEventListener('dragover', e => {
    e.preventDefault()
    const tag = e.target.closest('.proxy-tag')
    if (!tag || tag.classList.contains('dragging')) return
    const container = tag.parentNode
    const dragEl = container.querySelector('.dragging')
    if (!dragEl) return
    const rect = tag.getBoundingClientRect()
    const mid = rect.left + rect.width / 2
    if (e.clientX < mid) {
      container.insertBefore(dragEl, tag)
    } else {
      container.insertBefore(dragEl, tag.nextSibling)
    }
  })
  list.addEventListener('drop', async e => {
    e.preventDefault()
    const dragEl = list.querySelector('.proxy-tag.dragging')
    if (!dragEl) return
    const fromGroup = dragEl.dataset.group
    const proxiesEl = dragEl.parentNode
    const reordered = Array.from(proxiesEl.querySelectorAll('.proxy-tag')).map(el => el.textContent)
    try {
      await API.put(`/api/config/proxy-groups/${encodeURIComponent(fromGroup)}`, {
        ..._groupsData.find(g => g.name === fromGroup),
        proxies: reordered,
      })
      toast('代理排序已保存', 'success')
      switchView('groups')
    } catch { toast('排序保存失败', 'error') }
  })
  list.addEventListener('dragend', e => {
    const tag = e.target.closest('.proxy-tag')
    if (tag) tag.classList.remove('dragging')
  })
}

const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance']

async function showGroupForm(name) {
  let group = { name: '', type: 'select', proxies: [] }
  const allGroups = await API.get('/api/config/proxy-groups')
  if (name) {
    group = allGroups.find(g => g.name === name) || group
  }
  _msAvailable = allGroups.filter(g => g.name !== group.name).map(g => g.name)
  if (!_msAvailable.includes('DIRECT')) _msAvailable.push('DIRECT')
  _msSelected = new Set(group.proxies || [])
  showModal(`
    <h3>${name ? '编辑' : '添加'}代理组</h3>
    <div class="form-group"><label>名称</label><input id="gf-name" value="${esc(group.name)}" ${name ? 'readonly' : ''} /></div>
    <div class="form-group"><label>类型</label><select id="gf-type">${GROUP_TYPES.map(t => `<option value="${t}" ${group.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-group">
      <label>Proxies</label>
      <div class="multi-select" id="gf-proxies">
        <div class="ms-tags" id="gf-proxies-tags"></div>
        <input class="ms-search" id="gf-proxies-search" placeholder="搜索代理组或输入自定义名称，回车添加..." autocomplete="off" />
        <div class="ms-dropdown hidden" id="gf-proxies-dropdown"></div>
      </div>
    </div>
    <div class="form-group">
    	<div style="display: flex; align-items: center;">
    		<label for="gf-include-all" style="white-space: nowrap">include-all</label>
    		<input type="checkbox" id="gf-include-all" ${group['include-all']?'checked':''} />
			</div>
    </div>
    <div class="form-group"><label>Filter (正则)</label><input id="gf-filter" value="${esc(group.filter || '')}" /></div>
    <div id="gf-extra">
      ${group.type === 'url-test' ? `
        <div class="form-row">
          <div class="form-group"><label>Tolerance (ms)</label><input id="gf-tolerance" type="number" value="${group.tolerance || 0}" /></div>
        </div>` : ''}
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="saveGroup('${esc(group.name)}')">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  `)
  initMs(document.getElementById('gf-proxies'))
  document.getElementById('gf-type').addEventListener('change', () => {
    if (document.getElementById('gf-type').value === 'url-test') {
      document.getElementById('gf-extra').innerHTML = `
        <div class="form-row">
          <div class="form-group"><label>Tolerance (ms)</label><input id="gf-tolerance" type="number" value="0" /></div>
        </div>`
    } else {
      document.getElementById('gf-extra').innerHTML = ''
    }
  })
}

async function saveGroup(oldName) {
  const data = {
    name: document.getElementById('gf-name').value,
    type: document.getElementById('gf-type').value,
    proxies: [..._msSelected],
    'include-all': document.getElementById('gf-include-all').checked,
    filter: document.getElementById('gf-filter').value || undefined,
  }
  if (data.type === 'url-test') {
    data.tolerance = parseInt(document.getElementById('gf-tolerance')?.value) || 0
  }
  Object.keys(data).forEach(k => { if (data[k] === undefined || data[k] === null) delete data[k] })
  if (!data.filter) delete data.filter
  if (!data['include-all']) delete data['include-all']
  try {
    if (oldName) {
      await API.put(`/api/config/proxy-groups/${encodeURIComponent(oldName)}`, data)
    } else {
      await API.post('/api/config/proxy-groups', data)
    }
    closeModal()
    toast('已保存', 'success')
    switchView('groups')
  } catch { toast('保存失败', 'error') }
}

function initMs(container) {
  const search = container.querySelector('#gf-proxies-search')
  const dropdown = container.querySelector('#gf-proxies-dropdown')
  renderMsTags(container)
  filterMsDropdown(container)
  search.addEventListener('input', () => filterMsDropdown(container))
  search.addEventListener('focus', () => { filterMsDropdown(container); dropdown.classList.remove('hidden') })
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.target.value.trim()
      if (val) { _msSelected.add(val); e.target.value = ''; renderMsTags(container); filterMsDropdown(container) }
    }
  })
  document.addEventListener('click', function closeMs(e) {
    if (!container.contains(e.target)) dropdown.classList.add('hidden')
  })
}

function renderMsTags(container) {
  const tagsEl = container.querySelector('#gf-proxies-tags')
  tagsEl.innerHTML = [..._msSelected].map(v =>
    `<span class="ms-tag">${esc(v)}<span class="ms-tag-remove" data-value="${esc(v)}">&times;</span></span>`
  ).join('')
  tagsEl.querySelectorAll('.ms-tag-remove').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      _msSelected.delete(el.dataset.value)
      renderMsTags(container)
      filterMsDropdown(container)
    })
  })
}

function filterMsDropdown(container) {
  const search = (container.querySelector('#gf-proxies-search')?.value || '').toLowerCase()
  const dropdown = container.querySelector('#gf-proxies-dropdown')
  const filtered = _msAvailable.filter(o => o.toLowerCase().includes(search))
  dropdown.innerHTML = filtered.map(o =>
    `<div class="ms-option${_msSelected.has(o) ? ' selected' : ''}" data-value="${esc(o)}">${o}</div>`
  ).join('')
  dropdown.querySelectorAll('.ms-option').forEach(el => {
    el.addEventListener('click', () => {
      const v = el.dataset.value
      _msSelected.has(v) ? _msSelected.delete(v) : _msSelected.add(v)
      renderMsTags(container)
      filterMsDropdown(container)
      container.querySelector('#gf-proxies-search').focus()
    })
  })
  dropdown.classList.toggle('hidden', filtered.length === 0)
}

async function deleteGroup(name) {
  if (!confirm(`删除代理组 "${name}"？`)) return
  await API.del(`/api/config/proxy-groups/${encodeURIComponent(name)}`)
  toast('已删除', 'success')
  switchView('groups')
}

/* ============ Rules ============ */
let _dragRuleIndex = null
let _rulesData = []

async function renderRules(container) {
  _rulesData = await API.get('/api/config/rules')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">规则管理</h2>
      <div><small style="color:var(--text-muted);margin-right:8px">拖拽规则可排序</small><button class="btn-primary" onclick="showRuleForm()">+ 添加</button></div>
    </div>
    <div id="rule-list">
      ${_rulesData.length ? _rulesData.map((r, i) => `
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
    switchView('rules')
  } catch { toast('排序保存失败', 'error') }
}

const RULE_TYPES = ['MATCH', 'GEOIP', 'GEOSITE', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'SRC-IP-CIDR', 'DST-PORT', 'SRC-PORT', 'PROCESS-NAME']

async function showRuleForm(index) {
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
      <select id="rf-type" onchange="toggleGeositeBtn()">
        ${RULE_TYPES.map(t => `<option value="${t}" ${type===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>参数 (payload)</label>
      <div style="display:flex;gap:8px">
        <input id="rf-payload" value="${esc(payload)}" style="flex:1" />
        <button id="geosite-btn" class="btn-sm btn-warning" onclick="openGeositePicker()" style="display:${type==='GEOSITE'?'block':'none'}">GeoSite</button>
      </div>
    </div>
    <div class="form-group"><label>代理组</label><select id="rf-proxy">${proxyOptions.map(o => `<option value="${esc(o)}" ${proxy===o?'selected':''}>${esc(o)}</option>`).join('')}</select></div>
    <div class="form-group">
    	<div style="display: flex; align-items: center">
    		<label for="rf-noresolve" style="white-space: nowrap">no-resolve</label>
    		<input type="checkbox" id="rf-noresolve" ${noResolve?'checked':''} />
			</div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="saveRule(${index !== undefined && index >= 0 ? index : 'undefined'})">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  `)
}

function toggleGeositeBtn() {
  const btn = document.getElementById('geosite-btn')
  if (btn) btn.style.display = document.getElementById('rf-type').value === 'GEOSITE' ? 'block' : 'none'
}

async function openGeositePicker() {
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

function filterGeosite() {
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

function toggleGeositeCategory(el) {
  el.closest('.gs-category').classList.toggle('open')
}

function selectGeosite(category) {
  closeModal()
  showRuleForm(-1)
  document.getElementById('rf-type').value = 'GEOSITE'
  document.getElementById('rf-payload').value = category
  toggleGeositeBtn()
}

async function saveRule(index) {
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
    switchView('rules')
  } catch { toast('保存失败', 'error') }
}

async function deleteRule(index) {
  if (!confirm('删除此规则？')) return
  await API.del(`/api/config/rules/${index}`)
  toast('已删除', 'success')
  switchView('rules')
}

/* ============ GeoSite DAT Parser (Browser) ============ */
function parseGeositeDat(bytes) {
  const result = []
  const decoder = new TextDecoder('utf-8', { fatal: false })

  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return -1
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  // Strategy 1: raw protobuf format (current MetaCubeX / v2fly)
  // Top-level: repeated field 1 (wire type 2) = GeoSite message
  // GeoSite: field 1 = name (string), field 2 = Site[] (sub-messages)
  // Site: field 1 = type (varint), field 2 = value (string)
  {
    const pos = { i: 0 }
    while (pos.i < bytes.length) {
      const tag = readVarint(bytes, pos)
      if (tag === -1 || tag === 0) break
      const fieldNum = tag >> 3
      const wireType = tag & 0x7
      if (wireType !== 2) {
        if (wireType === 0) { if (readVarint(bytes, pos) === -1) break }
        else if (wireType === 5) pos.i += 4
        else if (wireType === 1) pos.i += 8
        else break
        continue
      }
      const len = readVarint(bytes, pos)
      if (len === -1 || pos.i + len > bytes.length) break
      if (fieldNum === 1) {
        const gs = parseGeositeProtobuf(bytes.slice(pos.i, pos.i + len), decoder)
        if (gs && gs.name && !result.some(c => c.name === gs.name)) {
          result.push(gs)
        }
      }
      pos.i += len
    }
  }

  // Strategy 2: v2fly standard format — [nameLen(2 LE)][name][dataLen(2 LE)][protobuf data]
  if (result.length === 0) {
    let offset = 0
    while (offset + 4 <= bytes.length) {
      const nameLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (nameLen === 0 || offset + nameLen > bytes.length) break
      let name = ''
      try { name = decoder.decode(bytes.slice(offset, offset + nameLen)) } catch {}
      offset += nameLen
      if (!name || name.length > 128 || !/^[a-zA-Z0-9@._\u{80}-\u{FFFF}-]+$/u.test(name)) {
        if (offset + 2 > bytes.length) break
        const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
        offset += 2 + dataLen
        continue
      }
      if (offset + 2 > bytes.length) break
      const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (dataLen === 0 || offset + dataLen > bytes.length) break
      if (!result.some(c => c.name === name)) {
        const gs = parseGeositeProtobuf(bytes.slice(offset, offset + dataLen), decoder)
        result.push({ name, domains: gs ? gs.domains : [] })
      }
      offset += dataLen
    }
  }

  // Strategy 3: varint-framed protobuf entries (older v2ray format)
  if (result.length === 0) {
    let offset = 0
    try {
      while (offset < bytes.length) {
        let tag = 0, shift = 0
        while (offset < bytes.length) {
          const b = bytes[offset++]
          tag |= (b & 0x7f) << shift
          shift += 7
          if (!(b & 0x80)) break
        }
        if (tag === 0) break
        let len = 0; shift = 0
        while (offset < bytes.length) {
          const b = bytes[offset++]
          len |= (b & 0x7f) << shift
          shift += 7
          if (!(b & 0x80)) break
        }
        if (len === 0 || offset + len > bytes.length) break
        const slice = bytes.slice(offset, offset + len)
        let str = ''
        try { str = decoder.decode(slice) } catch {}
        if (str && str.length >= 1 && str.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(str)) {
          if (!result.some(c => c.name === str)) result.push({ name: str, domains: [] })
        }
        offset += len
      }
    } catch {}
  }

  // Strategy 4: scan for printable ASCII strings
  if (result.length === 0) {
    let buf = ''
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]
      if (c >= 32 && c <= 126) {
        buf += String.fromCharCode(c)
      } else {
        if (buf.length >= 2 && buf.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(buf) && !buf.includes('.')) {
          if (!result.some(c => c.name === buf)) result.push({ name: buf, domains: [] })
        }
        buf = ''
      }
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function parseGeositeProtobuf(buf, decoder) {
  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return -1
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  // GeoSite protobuf: field 1 = name(string), field 2 = repeated Site
  const pos = { i: 0 }
  let name = null
  const domains = []

  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === -1 || tag === 0) break
    const fieldNum = tag >> 3
    const wireType = tag & 0x7

    if (wireType === 2) {
      const len = readVarint(buf, pos)
      if (len === -1 || pos.i + len > buf.length) break
      if (fieldNum === 1) {
        try { name = decoder.decode(buf.slice(pos.i, pos.i + len)) } catch {}
      } else if (fieldNum === 2) {
        parseSiteMessage(buf.slice(pos.i, pos.i + len), decoder, domains)
      }
      pos.i += len
    } else if (wireType === 0) {
      if (readVarint(buf, pos) === -1) break
    } else if (wireType === 5) {
      pos.i += 4
    } else if (wireType === 1) {
      pos.i += 8
    } else break
  }

  return name ? { name, domains } : null
}

function parseSiteMessage(buf, decoder, domains) {
  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  const pos = { i: 0 }
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === undefined || tag === 0) break
    const fieldNum = tag >> 3
    const wireType = tag & 0x7

    if (wireType === 2) {
      const len = readVarint(buf, pos)
      if (len === undefined || pos.i + len > buf.length) break
      if (fieldNum === 2) {
        try {
          const str = decoder.decode(buf.slice(pos.i, pos.i + len))
          if (str && str.length <= 255) domains.push(str)
        } catch {}
      }
      pos.i += len
    } else if (wireType === 0) {
      if (readVarint(buf, pos) === undefined) break
    } else if (wireType === 5) {
      pos.i += 4
    } else if (wireType === 1) {
      pos.i += 8
    } else break
  }
}

/* ============ Text Editor ============ */
async function renderEditor(container) {
  const res = await API.get('/api/config')
  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="font-size:18px">配置文本编辑</h2>
        <button class="btn-primary" onclick="saveEditor()">保存</button>
      </div>
      <textarea id="config-editor" rows="30" spellcheck="false">${esc(res.config || '')}</textarea>
    </div>`
}

async function saveEditor() {
  const text = document.getElementById('config-editor').value
  try {
    await API.put('/api/config', { config: text })
    toast('配置已保存', 'success')
  } catch { toast('保存失败: 请检查 YAML 格式', 'error') }
}

/* ============ Config Version History ============ */
async function renderVersions(container) {
  const versions = await API.get('/api/config/versions')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">配置历史版本</h2>
      <button class="btn-primary" onclick="saveVersion()">+ 保存当前版本</button>
    </div>
    <div id="version-list">
      ${versions.length ? versions.map(v => `
        <div class="version-item">
          <div class="info">
            <div class="name">${esc(v.label)}</div>
            <div class="time">${new Date(v.timestamp).toLocaleString('zh-CN')}</div>
          </div>
          <div class="actions">
            <button class="btn-sm btn-primary" onclick="viewVersion('${esc(v.id)}')">查看</button>
            <button class="btn-sm btn-success" onclick="restoreVersion('${esc(v.id)}')">恢复</button>
            <button class="btn-sm btn-danger" onclick="deleteVersion('${esc(v.id)}')">删除</button>
          </div>
        </div>
      `).join('') : '<div class="empty">暂无历史版本</div>'}
    </div>`
}

async function saveVersion() {
  const label = prompt('版本标签 (可选):') || ''
  try {
    await API.post('/api/config/versions', { label })
    toast('版本已保存', 'success')
    switchView('versions')
  } catch { toast('保存版本失败', 'error') }
}

async function viewVersion(id) {
  const res = await API.get(`/api/config/versions/${encodeURIComponent(id)}`)
  const version = await API.get('/api/config/versions')
  const v = version.find(x => x.id === id)
  showModal(`
    <h3>${esc(v ? v.label : '版本')}</h3>
    ${v ? `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">${new Date(v.timestamp).toLocaleString('zh-CN')}</p>` : ''}
    <div class="form-group">
      <textarea id="version-config-viewer" rows="20" spellcheck="false" readonly style="font-family:var(--font-mono);font-size:12px">${esc(res.config || '')}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn-success" onclick="closeModal();restoreVersion('${esc(id)}')">恢复此版本</button>
      <button onclick="closeModal()">关闭</button>
    </div>
  `)
}

async function restoreVersion(id) {
  if (!confirm('确定恢复到此版本？当前配置将被覆盖。')) return
  try {
    await API.post(`/api/config/versions/${encodeURIComponent(id)}/restore`)
    toast('已恢复到此版本', 'success')
    switchView('versions')
  } catch { toast('恢复失败', 'error') }
}

async function deleteVersion(id) {
  if (!confirm('删除此版本？')) return
  await API.del(`/api/config/versions/${encodeURIComponent(id)}`)
  toast('已删除', 'success')
  switchView('versions')
}

/* ============ Modal ============ */
function showModal(html) {
  closeModal()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">${html}</div>`
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal() })
  document.body.appendChild(overlay)
}

function closeModal() {
  const el = document.getElementById('modal-overlay')
  if (el) el.remove()
}

function esc(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

/* ============ Init ============ */
checkAuth()
