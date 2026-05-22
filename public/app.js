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

let currentView = 'index'

async function fetchPasswordStatus() {
  const res = await fetch('/api/password-status')
  const data = await res.json()
  return data.passwordSet
}

function renderSetup() {
  currentView = 'setup'
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <h1>Sub Magic</h1>
        <p>首次使用，请设置管理员密码</p>
        <div class="form-group">
          <label>密码 (至少6位)</label>
          <input type="password" id="setup-password" placeholder="设置管理密码" />
        </div>
        <div class="form-group">
          <label>确认密码</label>
          <input type="password" id="setup-password2" placeholder="再次输入密码" onkeydown="if(event.key==='Enter')doSetup()" />
        </div>
        <button class="btn-primary" onclick="doSetup()" style="width:100%">创建密码</button>
        <div id="setup-error" class="error"></div>
      </div>
    </div>`
}

async function doSetup() {
  const pwd = document.getElementById('setup-password').value
  const pwd2 = document.getElementById('setup-password2').value
  const errEl = document.getElementById('setup-error')

  if (pwd.length < 6) {
    errEl.textContent = '密码至少需要6位'
    return
  }
  if (pwd !== pwd2) {
    errEl.textContent = '两次密码不一致'
    return
  }

  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    })
    const data = await res.json()
    if (res.ok) {
      await checkAuth()
    } else {
      errEl.textContent = data.error || '设置失败'
    }
  } catch {
    errEl.textContent = '网络错误'
  }
}

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
    const passwordSet = await fetchPasswordStatus()
    if (!passwordSet) {
      renderSetup()
      return
    }
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
  currentView = 'index'
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="topbar">
      <h1>Sub Magic</h1>
      <nav>
        <button class="active" data-view="index" onclick="switchView('index')">首页</button>
        <button data-view="providers" onclick="switchView('providers')">订阅源</button>
        <button data-view="groups" onclick="switchView('groups')">代理组</button>
        <button data-view="rules" onclick="switchView('rules')">规则</button>
        <button data-view="editor" onclick="switchView('editor')">文本编辑</button>
        <button data-view="versions" onclick="switchView('versions')">历史版本</button>
      </nav>
      <button class="btn-logout" onclick="doLogout()">登出</button>
    </div>
    <div id="view-container"></div>`
  switchView('index')
}

function switchView(view) {
  currentView = view
  document.querySelectorAll('.topbar nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view)
  })
  const container = document.getElementById('view-container')
  switch (view) {
    case 'index': renderDashboard(container); break
    case 'providers': renderProviders(container); break
    case 'groups': renderGroups(container); break
    case 'rules': renderRules(container); break
    case 'editor': renderEditor(container); break
    case 'versions': renderVersions(container); break
  }
}

/* ============ Index ============ */
async function renderDashboard(container) {
  const keyRes = await API.get('/api/access-key')
  const configRes = await API.get('/api/config')
  const config = configRes.config || ''
  let providerCount = 0
  try {
    const providers = await API.get('/api/config/proxy-providers')
    providerCount = Array.isArray(providers) ? providers.length : Object.keys(providers).length
  } catch { /* ignore */ }
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
      <p>订阅源数: ${providerCount}</p>
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
    	<label for="gf-include-all" style="white-space: nowrap">
    		include-all
    		<input type="checkbox" id="gf-include-all" ${group['include-all']?'checked':''} />
    	</label>
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

function togglePickerBtns() {
  const type = document.getElementById('rf-type').value
  const gsBtn = document.getElementById('geosite-btn')
  const giBtn = document.getElementById('geoip-btn')
  if (gsBtn) gsBtn.style.display = type === 'GEOSITE' ? 'block' : 'none'
  if (giBtn) giBtn.style.display = type === 'GEOIP' ? 'block' : 'none'
}

function toggleGeositeBtn() { togglePickerBtns() }

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

async function selectGeosite(category) {
  closeModal()
  await showRuleForm(-1)
  document.getElementById('rf-type').value = 'GEOSITE'
  document.getElementById('rf-payload').value = category
  toggleGeositeBtn()
}

/* ============ GeoIP Picker ============ */
async function openGeoipPicker() {
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

const GEOIP_NAMES = {
  AD:'安道尔',AE:'阿联酋',AF:'阿富汗',AG:'安提瓜和巴布达',AI:'安圭拉',AL:'阿尔巴尼亚',AM:'亚美尼亚',AO:'安哥拉',AQ:'南极洲',
  AR:'阿根廷',AS:'美属萨摩亚',AT:'奥地利',AU:'澳大利亚',AW:'阿鲁巴',AX:'奥兰群岛',AZ:'阿塞拜疆',
  BA:'波黑',BB:'巴巴多斯',BD:'孟加拉国',BE:'比利时',BF:'布基纳法索',BG:'保加利亚',BH:'巴林',BI:'布隆迪',BJ:'贝宁',BL:'圣巴泰勒米',
  BM:'百慕大',BN:'文莱',BO:'玻利维亚',BQ:'荷兰加勒比区',BR:'巴西',BS:'巴哈马',BT:'不丹',BW:'博茨瓦纳',BY:'白俄罗斯',BZ:'伯利兹',
  CA:'加拿大',CC:'科科斯群岛',CD:'刚果(金)',CF:'中非共和国',CG:'刚果(布)',CH:'瑞士',CI:'科特迪瓦',CK:'库克群岛',CL:'智利',CM:'喀麦隆',
  CN:'中国',CO:'哥伦比亚',CR:'哥斯达黎加',CU:'古巴',CV:'佛得角',CW:'库拉索',CX:'圣诞岛',CY:'塞浦路斯',CZ:'捷克',
  DE:'德国',DJ:'吉布提',DK:'丹麦',DM:'多米尼克',DO:'多米尼加',DZ:'阿尔及利亚',
  EC:'厄瓜多尔',EE:'爱沙尼亚',EG:'埃及',EH:'西撒哈拉',ER:'厄立特里亚',ES:'西班牙',ET:'埃塞俄比亚',
  FI:'芬兰',FJ:'斐济',FK:'福克兰群岛',FM:'密克罗尼西亚',FO:'法罗群岛',FR:'法国',
  GA:'加蓬',GB:'英国',GD:'格林纳达',GE:'格鲁吉亚',GF:'法属圭亚那',GG:'根西岛',GH:'加纳',GI:'直布罗陀',GL:'格陵兰',GM:'冈比亚',
  GN:'几内亚',GP:'瓜德罗普',GQ:'赤道几内亚',GR:'希腊',GS:'南乔治亚',GT:'危地马拉',GU:'关岛',GW:'几内亚比绍',GY:'圭亚那',
  HK:'香港',HN:'洪都拉斯',HR:'克罗地亚',HT:'海地',HU:'匈牙利',
  ID:'印尼',IE:'爱尔兰',IL:'以色列',IM:'马恩岛',IN:'印度',IO:'英属印度洋领地',IQ:'伊拉克',IR:'伊朗',IS:'冰岛',IT:'意大利',
  JE:'泽西岛',JM:'牙买加',JO:'约旦',JP:'日本',
  KE:'肯尼亚',KG:'吉尔吉斯斯坦',KH:'柬埔寨',KI:'基里巴斯',KM:'科摩罗',KN:'圣基茨和尼维斯',KP:'朝鲜',KR:'韩国',KW:'科威特',KY:'开曼群岛',KZ:'哈萨克斯坦',
  LA:'老挝',LB:'黎巴嫩',LC:'圣卢西亚',LI:'列支敦士登',LK:'斯里兰卡',LR:'利比里亚',LS:'莱索托',LT:'立陶宛',LU:'卢森堡',LV:'拉脱维亚',LY:'利比亚',
  MA:'摩洛哥',MC:'摩纳哥',MD:'摩尔多瓦',ME:'黑山',MF:'法属圣马丁',MG:'马达加斯加',MH:'马绍尔群岛',MK:'北马其顿',ML:'马里',MM:'缅甸',
  MN:'蒙古',MO:'澳门',MP:'北马里亚纳群岛',MQ:'马提尼克',MR:'毛里塔尼亚',MS:'蒙特塞拉特',MT:'马耳他',MU:'毛里求斯',MV:'马尔代夫',
  MW:'马拉维',MX:'墨西哥',MY:'马来西亚',MZ:'莫桑比克',
  NA:'纳米比亚',NC:'新喀里多尼亚',NE:'尼日尔',NF:'诺福克岛',NG:'尼日利亚',NI:'尼加拉瓜',NL:'荷兰',NO:'挪威',NP:'尼泊尔',NR:'瑙鲁',
  NU:'纽埃',NZ:'新西兰',
  OM:'阿曼',
  PA:'巴拿马',PE:'秘鲁',PF:'法属波利尼西亚',PG:'巴布亚新几内亚',PH:'菲律宾',PK:'巴基斯坦',PL:'波兰',PM:'圣皮埃尔和密克隆',
  PN:'皮特凯恩群岛',PR:'波多黎各',PS:'巴勒斯坦',PT:'葡萄牙',PW:'帕劳',PY:'巴拉圭',
  QA:'卡塔尔',
  RE:'留尼汪',RO:'罗马尼亚',RS:'塞尔维亚',RU:'俄罗斯',RW:'卢旺达',
  SA:'沙特',SB:'所罗门群岛',SC:'塞舌尔',SD:'苏丹',SE:'瑞典',SG:'新加坡',SH:'圣赫勒拿',SI:'斯洛文尼亚',SJ:'斯瓦尔巴群岛',
  SK:'斯洛伐克',SL:'塞拉利昂',SM:'圣马力诺',SN:'塞内加尔',SO:'索马里',SR:'苏里南',SS:'南苏丹',ST:'圣多美和普林西比',
  SV:'萨尔瓦多',SX:'荷属圣马丁',SY:'叙利亚',SZ:'斯威士兰',
  TC:'特克斯和凯科斯群岛',TD:'乍得',TF:'法属南部领地',TG:'多哥',TH:'泰国',TJ:'塔吉克斯坦',TK:'托克劳',TL:'东帝汶',
  TM:'土库曼斯坦',TN:'突尼斯',TO:'汤加',TR:'土耳其',TT:'特立尼达和多巴哥',TV:'图瓦卢',TW:'台湾',TZ:'坦桑尼亚',
  UA:'乌克兰',UG:'乌干达',UM:'美国本土外小岛屿',US:'美国',UY:'乌拉圭',UZ:'乌兹别克斯坦',
  VA:'梵蒂冈',VC:'圣文森特和格林纳丁斯',VE:'委内瑞拉',VG:'英属维尔京群岛',VI:'美属维尔京群岛',VN:'越南',VU:'瓦努阿图',
  WF:'瓦利斯和富图纳',WS:'萨摩亚',
  YE:'也门',YT:'马约特',
  ZA:'南非',ZM:'赞比亚',ZW:'津巴布韦',
  PRIVATE:'私有',TENCENT:'腾讯',GOOGLE:'Google',NETFLIX:'Netflix',TWITTER:'Twitter',TELEGRAM:'Telegram',
  CLOUDFLARE:'Cloudflare',CLOUDFRONT:'CloudFront',FACEBOOK:'Facebook',FASTLY:'Fastly',APPLE:'Apple',AMAZON:'Amazon',
  MICROSOFT:'微软',BING:'Bing',LINE:'Line',LAN:'局域网',  'CATEGORY-ADS':'广告','CATEGORY-ADULT':'成人内容',
  'CATEGORY-GAMBLING':'赌博','CATEGORY-GOVERNMENT':'政府','CATEGORY-MILITARY':'军事','CATEGORY-NEWLY':'最新分类',
  'CATEGORY-SCHOLAR':'学术','CATEGORY-SECURITIES':'证券','CATEGORY-SOCIAL-MEDIA':'社交媒体','CATEGORY-SPORTS':'体育',
  'CATEGORY-TECH':'科技','GEOIP':null
}

function parseGeoipDat(bytes) {
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

  // Strategy 1: raw protobuf format (GeoIPList → field 1 = GeoIP → field 1 = country_code)
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
        // This is a GeoIP entry — extract field 1 = country_code
        const ipP = { i: pos.i }
        const end = pos.i + len
        while (ipP.i < end) {
          const ipTag = readVarint(bytes, ipP)
          if (ipTag === -1 || ipTag === 0) break
          const ipF = ipTag >> 3
          const ipW = ipTag & 0x7
          if (ipW === 2) {
            const ipL = readVarint(bytes, ipP)
            if (ipL === -1 || ipP.i + ipL > end) break
            if (ipF === 1) {
              try {
                const cc = decoder.decode(bytes.slice(ipP.i, ipP.i + ipL))
                if (cc && !result.some(r => r.code === cc)) result.push(cc)
              } catch {}
            }
            ipP.i += ipL
          } else if (ipW === 0) {
            if (readVarint(bytes, ipP) === -1) break
          } else if (ipW === 5) {
            ipP.i += 4
          } else if (ipW === 1) {
            ipP.i += 8
          } else break
        }
      }
      pos.i += len
    }
  }

  // Strategy 2: v2fly standard — [nameLen(2 LE)][name][dataLen(2 LE)][protobuf]
  if (result.length === 0) {
    let offset = 0
    while (offset + 4 <= bytes.length) {
      const nameLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (nameLen === 0 || nameLen > 64 || offset + nameLen > bytes.length) break
      let cc = ''
      try { cc = decoder.decode(bytes.slice(offset, offset + nameLen)) } catch {}
      offset += nameLen
      if (!cc || !/^[A-Za-z0-9_-]+$/.test(cc)) {
        if (offset + 2 > bytes.length) break
        const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
        offset += 2 + dataLen
        continue
      }
      if (offset + 2 > bytes.length) break
      const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (offset + dataLen > bytes.length) break
      if (!result.some(r => r.code === cc)) result.push(cc)
      offset += dataLen
    }
  }

  // Strategy 3: varint-framed entries
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
        if (str && str.length >= 1 && str.length <= 64 && /^[A-Za-z0-9_-]+$/.test(str)) {
          if (!result.some(r => r.code === str)) result.push(str)
        }
        offset += len
      }
    } catch {}
  }

  // Strategy 4: scan for printable ASCII strings (2-3 char codes)
  if (result.length === 0) {
    let buf = ''
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]
      if (c >= 32 && c <= 126) {
        buf += String.fromCharCode(c)
      } else {
        if ((buf.length === 2 || buf.length === 3) && /^[A-Z]{2,3}$/.test(buf)) {
          if (!result.some(r => r.code === buf)) result.push(buf)
        }
        buf = ''
      }
    }
  }

  // Map to objects with code + name, sort
  return result.map(code => ({ code, name: GEOIP_NAMES[code.toUpperCase()] || code }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

function filterGeoip() {
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

async function selectGeoip(country) {
  closeModal()
  await showRuleForm(-1)
  document.getElementById('rf-type').value = 'GEOIP'
  document.getElementById('rf-payload').value = country
  togglePickerBtns()
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
