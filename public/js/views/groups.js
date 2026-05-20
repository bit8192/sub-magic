import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'
import { groupsData as _groupsData, setGroupsData, msAvailable, msSelectedState } from '../state.js'

export const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance']

export async function renderGroups(container) {
  const data = await API.get('/api/config/proxy-groups')
  setGroupsData(data)
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">代理组管理</h2>
      <div><small style="color:var(--text-muted);margin-right:8px">拖拽代理可排序</small><button class="btn-primary" onclick="showGroupForm()">+ 添加</button></div>
    </div>
    <div id="group-list">
      ${data.length ? data.map(g => `
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
      window.switchView('groups')
    } catch { toast('排序保存失败', 'error') }
  })
  list.addEventListener('dragend', e => {
    const tag = e.target.closest('.proxy-tag')
    if (tag) tag.classList.remove('dragging')
  })
}

export async function showGroupForm(name) {
  let group = { name: '', type: 'select', proxies: [] }
  const allGroups = await API.get('/api/config/proxy-groups')
  if (name) {
    group = allGroups.find(g => g.name === name) || group
  }
  msAvailable.length = 0
  msAvailable.push(...allGroups.filter(g => g.name !== group.name).map(g => g.name))
  if (!msAvailable.includes('DIRECT')) msAvailable.push('DIRECT')
  msSelectedState.clear()
  ;(group.proxies || []).forEach(p => msSelectedState.add(p))
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

export async function saveGroup(oldName) {
  const data = {
    name: document.getElementById('gf-name').value,
    type: document.getElementById('gf-type').value,
    proxies: [...msSelectedState],
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
    window.switchView('groups')
  } catch { toast('保存失败', 'error') }
}

export async function deleteGroup(name) {
  if (!confirm(`删除代理组 "${name}"？`)) return
  await API.del(`/api/config/proxy-groups/${encodeURIComponent(name)}`)
  toast('已删除', 'success')
  window.switchView('groups')
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
      if (val) { msSelectedState.add(val); e.target.value = ''; renderMsTags(container); filterMsDropdown(container) }
    }
  })
  document.addEventListener('click', function closeMs(e) {
    if (!container.contains(e.target)) dropdown.classList.add('hidden')
  })
}

function renderMsTags(container) {
  const tagsEl = container.querySelector('#gf-proxies-tags')
  tagsEl.innerHTML = [...msSelectedState].map(v =>
    `<span class="ms-tag">${esc(v)}<span class="ms-tag-remove" data-value="${esc(v)}">&times;</span></span>`
  ).join('')
  tagsEl.querySelectorAll('.ms-tag-remove').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      msSelectedState.delete(el.dataset.value)
      renderMsTags(container)
      filterMsDropdown(container)
    })
  })
}

function filterMsDropdown(container) {
  const search = (container.querySelector('#gf-proxies-search')?.value || '').toLowerCase()
  const dropdown = container.querySelector('#gf-proxies-dropdown')
  const filtered = msAvailable.filter(o => o.toLowerCase().includes(search))
  dropdown.innerHTML = filtered.map(o =>
    `<div class="ms-option${msSelectedState.has(o) ? ' selected' : ''}" data-value="${esc(o)}">${o}</div>`
  ).join('')
  dropdown.querySelectorAll('.ms-option').forEach(el => {
    el.addEventListener('click', () => {
      const v = el.dataset.value
      msSelectedState.has(v) ? msSelectedState.delete(v) : msSelectedState.add(v)
      renderMsTags(container)
      filterMsDropdown(container)
      container.querySelector('#gf-proxies-search').focus()
    })
  })
  dropdown.classList.toggle('hidden', filtered.length === 0)
}
