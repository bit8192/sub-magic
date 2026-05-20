import { API } from '../api.js'
import { esc, toast, showModal, closeModal } from '../utils.js'

export async function renderVersions(container) {
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

export async function saveVersion() {
  const label = prompt('版本标签 (可选):') || ''
  try {
    await API.post('/api/config/versions', { label })
    toast('版本已保存', 'success')
    window.switchView('versions')
  } catch { toast('保存版本失败', 'error') }
}

export async function viewVersion(id) {
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

export async function restoreVersion(id) {
  if (!confirm('确定恢复到此版本？当前配置将被覆盖。')) return
  try {
    await API.post(`/api/config/versions/${encodeURIComponent(id)}/restore`)
    toast('已恢复到此版本', 'success')
    window.switchView('versions')
  } catch { toast('恢复失败', 'error') }
}

export async function deleteVersion(id) {
  if (!confirm('删除此版本？')) return
  await API.del(`/api/config/versions/${encodeURIComponent(id)}`)
  toast('已删除', 'success')
  window.switchView('versions')
}
