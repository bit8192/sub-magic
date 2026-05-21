import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'
import { groupsData as _groupsData, setGroupsData } from '../state.js'

export const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay']

const msStores = {
  proxies: { available: [], selected: new Set() },
  use: { available: [], selected: new Set() },
}

export async function renderGroups(container) {
  const data = await API.get('/api/config/proxy-groups')
  setGroupsData(data)
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">代理组管理</h2>
      <div><small style="color:var(--text-muted);margin-right:8px">显式 proxies 可拖拽排序</small><button class="btn-primary" onclick="showGroupForm()">+ 添加</button></div>
    </div>
    <div id="group-list">
      ${data.length ? data.map(g => `
        <div class="group-card" data-group="${esc(g.name)}">
          <div class="header">
            <div><span class="name">${esc(g.name)}</span> <span class="type">${esc(g.type)}</span></div>
            <div class="actions">
              <button class="btn-sm btn-primary" onclick="showGroupForm('${esc(g.name)}')">编辑</button>
              <button class="btn-sm btn-danger" onclick="deleteGroup('${esc(g.name)}')">删除</button>
            </div>
          </div>
          <div class="group-meta">${renderGroupMeta(g)}</div>
          ${renderGroupTokens('显式 Proxies', g.proxies, g.name)}
          ${renderStaticTokens('Use Providers', g.use)}
          ${renderGroupNotes(g)}
        </div>
      `).join('') : '<div class="empty">暂无代理组</div>'}
    </div>`
  attachProxyDrag()
}

function renderGroupMeta(group) {
  const items = []
  if (group.hidden) items.push('hidden')
  return items.length ? items.map(v => `<span class="meta-pill">${esc(String(v))}</span>`).join('') : '<span class="meta-empty">无额外元信息</span>'
}

function renderGroupTokens(label, values, groupName) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return `
    <div class="group-section-label">${esc(label)}</div>
    <div class="proxies">${values.map((p, pi) => `<span class="proxy-tag" draggable="true" data-proxy-index="${pi}" data-group="${esc(groupName)}">${esc(p)}</span>`).join('')}</div>
  `
}

function renderStaticTokens(label, values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return `
    <div class="group-section-label">${esc(label)}</div>
    <div class="proxies">${values.map(v => `<span class="proxy-tag static">${esc(v)}</span>`).join('')}</div>
  `
}

function renderGroupNotes(group) {
  const notes = []
  if (group['include-all']) notes.push('include-all')
  if (group['include-all-proxies']) notes.push('include-all-proxies')
  if (group['include-all-providers']) notes.push('include-all-providers')
  if (group.filter) notes.push(`filter: ${group.filter}`)
  if (group['exclude-filter']) notes.push(`exclude-filter: ${group['exclude-filter']}`)
  if (group['exclude-type']) notes.push(`exclude-type: ${group['exclude-type']}`)
  if (group['disable-udp']) notes.push('disable-udp')
  if (group.icon) notes.push(`icon: ${group.icon}`)
  return notes.length ? `<div class="group-notes">${notes.map(n => `<div>${esc(String(n))}</div>`).join('')}</div>` : ''
}

function attachProxyDrag() {
  const list = document.getElementById('group-list')
  if (!list) return
  list.addEventListener('dragstart', e => {
    const tag = e.target.closest('.proxy-tag')
    if (!tag || tag.classList.contains('static')) return
    tag.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({
      group: tag.dataset.group,
      index: parseInt(tag.dataset.proxyIndex, 10),
    }))
  })
  list.addEventListener('dragover', e => {
    e.preventDefault()
    const tag = e.target.closest('.proxy-tag')
    if (!tag || tag.classList.contains('static') || tag.classList.contains('dragging')) return
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
    const reordered = Array.from(proxiesEl.querySelectorAll('.proxy-tag:not(.static)')).map(el => el.textContent)
    try {
      await API.put(`/api/config/proxy-groups/${encodeURIComponent(fromGroup)}`, {
        ..._groupsData.find(g => g.name === fromGroup),
        proxies: reordered,
      })
      toast('代理排序已保存', 'success')
      window.switchView('groups')
    } catch { toast('排序保存失败', 'error') }
  })
  list.addEventListener('dragend', e => {
    const tag = e.target.closest('.proxy-tag')
    if (tag) tag.classList.remove('dragging')
  })
}

export async function showGroupForm(name) {
  let group = { name: '', type: 'select', proxies: [], use: [] }
  const [allGroups, allProviders] = await Promise.all([
    API.get('/api/config/proxy-groups'),
    API.get('/api/config/proxy-providers'),
  ])
  if (name) {
    group = allGroups.find(g => g.name === name) || group
  }

  msStores.proxies.available = allGroups.filter(g => g.name !== group.name).map(g => g.name)
  for (const builtIn of ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL']) {
    if (!msStores.proxies.available.includes(builtIn)) msStores.proxies.available.push(builtIn)
  }
  msStores.proxies.selected = new Set(group.proxies || [])
  msStores.use.available = allProviders.map(p => p.name)
  msStores.use.selected = new Set(group.use || [])

  showModal(`
    <h3>${name ? '编辑' : '添加'}代理组</h3>
    <div class="form-grid">
      <div class="form-group"><label>名称</label><input id="gf-name" value="${esc(group.name)}" ${name ? 'readonly' : ''} /></div>
      <div class="form-group"><label>类型</label><select id="gf-type">${GROUP_TYPES.map(t => `<option value="${t}" ${group.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    </div>

    <div class="form-section-title">成员来源</div>
    <div class="form-help">支持显式代理/组、代理提供者、以及 include-all 系列自动引入。</div>
    ${renderMsField('gf-proxies', '显式 Proxies / Groups', 'proxies', '搜索代理组或输入自定义名称，回车添加...')}
    ${renderMsField('gf-use', 'Use Providers', 'use', '搜索 provider 名称，回车添加...')}

    <div class="form-grid">
      <label class="checkbox-line">include-all <input type="checkbox" id="gf-include-all" ${group['include-all'] ? 'checked' : ''} /></label>
      <label class="checkbox-line">include-all-proxies <input type="checkbox" id="gf-include-all-proxies" ${group['include-all-proxies'] ? 'checked' : ''} /></label>
      <label class="checkbox-line">include-all-providers <input type="checkbox" id="gf-include-all-providers" ${group['include-all-providers'] ? 'checked' : ''} /></label>
      <label class="checkbox-line">disable-udp <input type="checkbox" id="gf-disable-udp" ${group['disable-udp'] ? 'checked' : ''} /></label>
      <label class="checkbox-line">hidden <input type="checkbox" id="gf-hidden" ${group.hidden ? 'checked' : ''} /></label>
    </div>

    <div class="form-section-title">筛选 / 排除</div>
    <div class="form-grid">
      <div class="form-group"><label>filter</label><input id="gf-filter" value="${esc(group.filter || '')}" placeholder="如 (?i)hk|hongkong" /></div>
      <div class="form-group"><label>exclude-filter</label><input id="gf-exclude-filter" value="${esc(group['exclude-filter'] || '')}" placeholder="如 JP|US" /></div>
      <div class="form-group"><label>exclude-type</label><input id="gf-exclude-type" value="${esc(group['exclude-type'] || '')}" placeholder="用 | 分隔，如 Shadowsocks|Http" /></div>
      <div class="form-group"><label>icon</label><input id="gf-icon" value="${esc(group.icon || '')}" placeholder="图标 URL 或名称" /></div>
    </div>

    <div class="form-actions">
      <button class="btn-primary" onclick="saveGroup('${esc(group.name)}')">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  `, 'group-form-modal')

  initMs(document.getElementById('gf-proxies'), 'proxies')
  initMs(document.getElementById('gf-use'), 'use')
}

function renderMsField(id, label, key, placeholder) {
  return `
    <div class="form-group">
      <label>${esc(label)}</label>
      <div class="multi-select" id="${id}" data-ms-key="${key}">
        <div class="ms-control">
          <div class="ms-tags"></div>
          <input class="ms-search" placeholder="${esc(placeholder)}" autocomplete="off" />
        </div>
        <div class="ms-dropdown hidden"></div>
      </div>
    </div>
  `
}

export async function saveGroup(oldName) {
  const data = {
    name: document.getElementById('gf-name').value.trim(),
    type: document.getElementById('gf-type').value,
    proxies: [...msStores.proxies.selected],
    use: [...msStores.use.selected],
    'include-all': document.getElementById('gf-include-all').checked,
    'include-all-proxies': document.getElementById('gf-include-all-proxies').checked,
    'include-all-providers': document.getElementById('gf-include-all-providers').checked,
    'disable-udp': document.getElementById('gf-disable-udp').checked,
    hidden: document.getElementById('gf-hidden').checked,
    filter: getOptionalValue('gf-filter'),
    'exclude-filter': getOptionalValue('gf-exclude-filter'),
    'exclude-type': getOptionalValue('gf-exclude-type'),
    icon: getOptionalValue('gf-icon'),
  }

  if (!data.name) {
    toast('名称不能为空', 'error')
    return
  }

  cleanEmptyGroupData(data)

  try {
    if (oldName) {
      await API.put(`/api/config/proxy-groups/${encodeURIComponent(oldName)}`, data)
    } else {
      await API.post('/api/config/proxy-groups', data)
    }
    closeModal()
    toast('已保存', 'success')
    window.switchView('groups')
  } catch { toast('保存失败', 'error') }
}

function cleanEmptyGroupData(data) {
  const falseyBooleanKeys = ['include-all', 'include-all-proxies', 'include-all-providers', 'disable-udp', 'hidden']
  for (const key of falseyBooleanKeys) {
    if (!data[key]) delete data[key]
  }
  if (!data.proxies?.length) delete data.proxies
  if (!data.use?.length) delete data.use
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') delete data[key]
  }
}

function getOptionalValue(id) {
  const value = document.getElementById(id)?.value?.trim()
  return value || undefined
}

export async function deleteGroup(name) {
  if (!confirm(`删除代理组 "${name}"？`)) return
  await API.del(`/api/config/proxy-groups/${encodeURIComponent(name)}`)
  toast('已删除', 'success')
  window.switchView('groups')
}

function initMs(container, key) {
  const control = container.querySelector('.ms-control')
  const search = container.querySelector('.ms-search')
  renderMsTags(container, key)
  filterMsDropdown(container, key)
  control.addEventListener('click', e => {
    if (e.target.closest('.ms-tag-remove')) return
    setMsOpen(container, key, true)
    search.focus()
  })
  search.addEventListener('input', () => {
    setMsOpen(container, key, true)
    filterMsDropdown(container, key)
  })
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.target.value.trim()
      if (val) {
        msStores[key].selected.add(val)
        e.target.value = ''
        renderMsTags(container, key)
        filterMsDropdown(container, key)
      }
    } else if (e.key === 'Escape') {
      setMsOpen(container, key, false)
    }
  })
  document.addEventListener('click', function closeMs(e) {
    if (!container.contains(e.target)) setMsOpen(container, key, false)
  })
}

function renderMsTags(container, key) {
  const tagsEl = container.querySelector('.ms-tags')
  tagsEl.innerHTML = [...msStores[key].selected].map(v =>
    `<span class="ms-tag">${esc(v)}<span class="ms-tag-remove" data-value="${esc(v)}">&times;</span></span>`
  ).join('')
  tagsEl.querySelectorAll('.ms-tag-remove').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      msStores[key].selected.delete(el.dataset.value)
      renderMsTags(container, key)
      filterMsDropdown(container, key)
    })
  })
}

function filterMsDropdown(container, key) {
  const search = (container.querySelector('.ms-search')?.value || '').toLowerCase()
  const dropdown = container.querySelector('.ms-dropdown')
  const filtered = msStores[key].available.filter(o => o.toLowerCase().includes(search))
  dropdown.innerHTML = filtered.map(o =>
    `<div class="ms-option${msStores[key].selected.has(o) ? ' selected' : ''}" data-value="${esc(o)}">${esc(o)}</div>`
  ).join('')
  dropdown.querySelectorAll('.ms-option').forEach(el => {
    el.addEventListener('click', () => {
      const v = el.dataset.value
      msStores[key].selected.has(v) ? msStores[key].selected.delete(v) : msStores[key].selected.add(v)
      renderMsTags(container, key)
      filterMsDropdown(container, key)
      container.querySelector('.ms-search').focus()
    })
  })
  dropdown.classList.toggle('hidden', !container.classList.contains('open') || filtered.length === 0)
}

function setMsOpen(container, key, open) {
  document.querySelectorAll('.multi-select.open').forEach(el => {
    if (el !== container) el.classList.remove('open')
  })
  container.classList.toggle('open', open)
  filterMsDropdown(container, key)
}
