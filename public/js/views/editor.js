import { API } from '../api.js'
import { esc, toast } from '../utils.js'

export async function renderEditor(container) {
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

export async function saveEditor() {
  const text = document.getElementById('config-editor').value
  try {
    await API.put('/api/config', { config: text })
    toast('配置已保存', 'success')
  } catch { toast('保存失败: 请检查 YAML 格式', 'error') }
}
