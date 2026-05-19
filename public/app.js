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
  }
}

/* ============ Dashboard ============ */
async function renderDashboard(container) {
  const keyRes = await API.get('/api/access-key')
  const configRes = await API.get('/api/config')
  const config = configRes.config || ''
  const providerCount = (config.match(/^\S+:\s*$/gm) || []).length

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
async function renderGroups(container) {
  const groups = await API.get('/api/config/proxy-groups')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">代理组管理</h2>
      <button class="btn-primary" onclick="showGroupForm()">+ 添加</button>
    </div>
    <div id="group-list">
      ${groups.length ? groups.map(g => `
        <div class="group-card">
          <div class="header">
            <div><span class="name">${esc(g.name)}</span> <span class="type">${g.type}</span></div>
            <div class="actions">
              <button class="btn-sm btn-primary" onclick="showGroupForm('${esc(g.name)}')">编辑</button>
              <button class="btn-sm btn-danger" onclick="deleteGroup('${esc(g.name)}')">删除</button>
            </div>
          </div>
          <div class="proxies">${(g.proxies || []).map(p => `<span class="proxy-tag">${esc(p)}</span>`).join('')}</div>
          ${g.filter ? `<div style="margin-top:4px;font-size:12px;color:var(--text-muted)">filter: ${esc(g.filter)}</div>` : ''}
          ${g['include-all'] ? '<div style="margin-top:4px;font-size:12px;color:var(--text-muted)">include-all: true</div>' : ''}
        </div>
      `).join('') : '<div class="empty">暂无代理组</div>'}
    </div>`
}

const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance']

async function showGroupForm(name) {
  let group = { name: '', type: 'select', proxies: [] }
  if (name) {
    const list = await API.get('/api/config/proxy-groups')
    group = list.find(g => g.name === name) || group
  }
  showModal(`
    <h3>${name ? '编辑' : '添加'}代理组</h3>
    <div class="form-group"><label>名称</label><input id="gf-name" value="${esc(group.name)}" ${name ? 'readonly' : ''} /></div>
    <div class="form-group"><label>类型</label><select id="gf-type">${GROUP_TYPES.map(t => `<option value="${t}" ${group.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-group"><label>Proxies (逗号分隔)</label><input id="gf-proxies" value="${esc((group.proxies || []).join(', '))}" /></div>
    <div class="form-group"><label><input type="checkbox" id="gf-include-all" ${group['include-all']?'checked':''} /> include-all</label></div>
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
    proxies: document.getElementById('gf-proxies').value.split(',').map(s => s.trim()).filter(Boolean),
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

async function deleteGroup(name) {
  if (!confirm(`删除代理组 "${name}"？`)) return
  await API.del(`/api/config/proxy-groups/${encodeURIComponent(name)}`)
  toast('已删除', 'success')
  switchView('groups')
}

/* ============ Rules ============ */
async function renderRules(container) {
  const rules = await API.get('/api/config/rules')
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">规则管理</h2>
      <button class="btn-primary" onclick="showRuleForm()">+ 添加</button>
    </div>
    <div id="rule-list">
      ${rules.length ? rules.map((r, i) => `
        <div class="rule-item">
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
    <div class="form-group"><label>代理组</label><input id="rf-proxy" value="${esc(proxy)}" /></div>
    <div class="form-group"><label><input type="checkbox" id="rf-noresolve" ${noResolve?'checked':''} /> no-resolve</label></div>
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
    const res = await API.post('/api/geosite/parse')
    toast('正在浏览器端解析 geosite.dat...')
    const decoded = atob(res.data)
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)

    const categories = parseGeositeDat(bytes)
    if (categories.length === 0) { toast('未找到分类', 'error'); return }

    closeModal()
    const container = document.getElementById('view-container')
    container.innerHTML = `
      <div class="card">
        <h2>选择 GeoSite 分类</h2>
        <div class="form-group"><input id="gs-search" placeholder="搜索分类..." oninput="filterGeosite()" /></div>
        <div class="geosite-categories" id="gs-list">
          ${categories.map(c => `<button onclick="selectGeosite('${esc(c)}')">${esc(c)}</button>`).join('')}
        </div>
        <div class="form-actions" style="margin-top:16px"><button onclick="switchView('rules')">返回</button></div>
      </div>`
    window._geositeCategories = categories
  } catch { toast('获取 geosite 数据失败', 'error') }
}

function filterGeosite() {
  const q = document.getElementById('gs-search').value.toLowerCase()
  const categories = window._geositeCategories || []
  document.getElementById('gs-list').innerHTML = categories
    .filter(c => c.toLowerCase().includes(q))
    .map(c => `<button onclick="selectGeosite('${esc(c)}')">${esc(c)}</button>`)
    .join('') || '<div class="empty">无匹配</div>'
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
  const categories = []
  let offset = 0
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  try {
    // v2ray geosite.dat uses protobuf-like format
    // Simplified parser: read varint-prefixed strings from the dat file
    while (offset < bytes.length - 4) {
      // Read field tag
      const tag = dataView.getUint16(offset, true)
      offset += 2
      if (tag === 0) break

      const len = dataView.getUint16(offset, true)
      offset += 2
      if (len === 0 || offset + len > bytes.length) break

      // Try to decode as UTF-8 string
      const slice = bytes.slice(offset, offset + len)
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const str = decoder.decode(slice)
        // Filter out non-category strings
        if (str.length >= 2 && str.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(str)) {
          if (!categories.includes(str)) categories.push(str)
        }
      } catch { /* not valid utf-8, skip */ }
      offset += len
    }
  } catch { /* parsing ended */ }

  // Fallback: scan for printable strings
  if (categories.length === 0) {
    let buf = ''
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]
      if (c >= 32 && c <= 126) {
        buf += String.fromCharCode(c)
      } else {
        if (buf.length >= 2 && buf.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(buf)) {
          if (!categories.includes(buf) && !buf.includes('.')) categories.push(buf)
        }
        buf = ''
      }
    }
  }

  return categories.sort()
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
