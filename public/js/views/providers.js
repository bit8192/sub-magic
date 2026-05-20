import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'

const usageCache = {}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function getExpiryText(expire) {
  if (!expire) return ''
  const now = Math.floor(Date.now() / 1000)
  const diff = expire - now
  if (diff <= 0) return '<span style="color:var(--danger)">已过期</span>'
  const days = Math.floor(diff / 86400)
  if (days > 365) return `到期 ${new Date(expire * 1000).toLocaleDateString('zh-CN')}`
  if (days > 30) return `剩余 ${Math.floor(days / 30)} 个月`
  if (days > 0) return `剩余 ${days} 天`
  const hours = Math.floor(diff / 3600)
  return `剩余 ${hours} 小时`
}

function renderUsageBar(info) {
  if (!info || (!info.total && !info.expire)) return ''
  const used = Math.max(info.download || 0, info.upload || 0)
  const total = info.total || 0
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  let barColor = 'var(--success)'
  if (pct > 90) barColor = 'var(--danger)'
  else if (pct > 70) barColor = 'var(--warning)'
  let sourceLabel = ''
  if (info.source === 'group-name-inference') {
    sourceLabel = ' <span style="font-size:10px;color:var(--warning)">(推断)</span>'
  } else if (info.source === 'header') {
    sourceLabel = ' <span style="font-size:10px;color:var(--success)">(响应头)</span>'
  }
  return `
    <div class="usage-info">
      ${total > 0 ? `
        <div class="usage-bar-container">
          <div class="usage-bar" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <div class="usage-text">
          <span>${formatBytes(used)} / ${formatBytes(total)} (${pct}%)</span>
          ${sourceLabel}
        </div>` : info.expire > 0 ? `
        <div class="usage-text">
          <span>${getExpiryText(info.expire)}</span>
          ${sourceLabel}
        </div>` : ''}
      ${info.details ? `<div class="usage-details">${esc(info.details)}</div>` : ''}
      ${info.checkedAt ? `<div class="usage-time">上次检查: ${new Date(info.checkedAt).toLocaleTimeString('zh-CN')}</div>` : ''}
    </div>`
}

export async function renderProviders(container) {
  const providers = await API.get('/api/config/proxy-providers')
  const names = providers.map(p => p.name)

  const cacheMap = {}
  names.forEach(name => { if (usageCache[name]) cacheMap[name] = usageCache[name] })

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">订阅源管理</h2>
      <div>
        <button class="btn-primary" onclick="window.checkAllUsage()">刷新全部</button>
        <button class="btn-primary" onclick="showProviderForm()" style="margin-left:8px">+ 添加</button>
      </div>
    </div>
    <div id="provider-list">
      ${providers.length ? providers.map(p => `
        <div class="provider-item" id="provider-${esc(p.name)}">
          <div class="provider-main">
            <div class="info">
              <div class="name">${esc(p.name)}</div>
              <div class="url">${esc(p.url || '')} · ${p.type || 'http'} · 间隔 ${p.interval || 86400}s</div>
            </div>
            <div class="actions">
              <button class="btn-sm btn-primary" onclick="showProviderForm('${esc(p.name)}')">编辑</button>
              <button class="btn-sm btn-danger" onclick="deleteProvider('${esc(p.name)}')">删除</button>
            </div>
          </div>
          <div class="provider-usage" id="usage-${esc(p.name)}">
            ${cacheMap[p.name] ? renderUsageBar(cacheMap[p.name]) : '<div style="padding:8px 0;color:var(--text-muted);font-size:12px">加载中...</div>'}
          </div>
        </div>
      `).join('') : '<div class="empty">暂无订阅源</div>'}
    </div>`

  for (const p of providers) {
    if (!usageCache[p.name]) {
      window.checkProviderUsage(p.name)
    }
  }
}

window.checkProviderUsage = async function(name) {
  const usageEl = document.getElementById(`usage-${name}`)
  if (usageEl) {
    usageEl.innerHTML = '<div style="padding:8px 0;color:var(--text-muted);font-size:12px">查询中...</div>'
  }
  try {
    const res = await API.post('/api/subscription-info', { name })
    if (res.error) {
      usageCache[name] = { error: res.error, checkedAt: Date.now() }
      if (usageEl) {
        usageEl.innerHTML = `<div style="padding:8px 0;color:var(--danger);font-size:12px">${esc(res.error)}</div>`
      }
    } else {
      usageCache[name] = res
      if (usageEl) {
        usageEl.innerHTML = renderUsageBar(res)
      }
    }
  } catch (e) {
    usageCache[name] = { error: e.message, checkedAt: Date.now() }
    if (usageEl) {
      usageEl.innerHTML = `<div style="padding:8px 0;color:var(--danger);font-size:12px">${esc(e.message)}</div>`
    }
  }
}

window.checkAllUsage = async function() {
  const providers = await API.get('/api/config/proxy-providers')
  for (const p of providers) {
    await window.checkProviderUsage(p.name)
  }
  toast('用量信息已更新', 'success')
}

export async function showProviderForm(name) {
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
    <div class="form-group"><label>User-Agent</label><input id="pf-ua" value="${esc(provider.ua || '')}" placeholder="clash-verge/v2.1.2" /></div>
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

export async function saveProvider(oldName) {
  const data = {
    name: document.getElementById('pf-name').value,
    url: document.getElementById('pf-url').value,
    type: document.getElementById('pf-type').value,
    interval: parseInt(document.getElementById('pf-interval').value) || 86400,
    ua: document.getElementById('pf-ua').value || undefined,
    'health-check': {
      enable: true,
      url: document.getElementById('pf-hc-url').value || 'https://www.gstatic.com/generate_204',
      interval: parseInt(document.getElementById('pf-hc-interval').value) || 300,
    },
    override: { 'additional-prefix': document.getElementById('pf-prefix').value || '' },
  }
  if (!data.ua) delete data.ua
  try {
    if (oldName) {
      await API.put(`/api/config/proxy-providers/${encodeURIComponent(oldName)}`, data)
    } else {
      await API.post('/api/config/proxy-providers', data)
    }
    closeModal()
    toast('已保存', 'success')
    window.switchView('providers')
  } catch { toast('保存失败', 'error') }
}

export async function deleteProvider(name) {
  if (!confirm(`删除订阅源 "${name}"？`)) return
  await API.del(`/api/config/proxy-providers/${encodeURIComponent(name)}`)
  delete usageCache[name]
  toast('已删除', 'success')
  window.switchView('providers')
}
