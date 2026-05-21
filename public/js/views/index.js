import { API } from '../api.js'
import { esc, toast } from '../utils.js'

export async function renderDashboard(container) {
	const [keyRes, configRes, metaRes] = await Promise.all([
		API.get('/api/access-key'),
		API.get('/api/config'),
		API.get('/api/config/meta'),
	])
	const config = configRes.config || ''
	const meta = metaRes || {}
	const providerCount = (config.match(/^\s+url:/gm) || []).length
	let versionCount = 0
	try {
		const versions = await API.get('/api/config/versions')
		versionCount = versions.length
	} catch { /* ignore */ }

	const subUrl = `${location.origin}/sub/${keyRes.key || ''}`

	let externalUiHtml = ''
	if (meta['external-controller'] && meta['external-ui']) {
		const controller = meta['external-controller']
		const ui = meta['external-ui']
		const extUrl = `http://${controller}/${ui.replace(/^\/+/, '')}`
		externalUiHtml = `
		<div class="card">
			<h2>外部管理界面</h2>
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:8px">${esc(controller + '/' + ui)}</p>
			<a href="${extUrl}" target="_blank" class="btn-primary">打开管理面板</a>
		</div>`
	}

	container.innerHTML = `
		<div class="card">
			<h2>订阅链接</h2>
			<div class="key-display">
				<input type="text" id="sub-url" readonly value="${subUrl}" />
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
		</div>
		${externalUiHtml}
		<div class="card">
			<h2>浏览器插件</h2>
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">安装浏览器插件后可在任意网站快速查询路由链路并添加规则</p>
			<div class="extension-links">
				<a href="/extensions/sub-magic-chrome.zip" download class="btn-primary extension-btn">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M2 8h12" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>
					下载 Chrome 插件
				</a>
				<a href="/extensions/sub-magic-firefox.xpi" target="_blank" class="btn-accent extension-btn">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 2c-2 2-3 4-3 6s1 4 3 6c2-2 3-4 3-6s-1-4-3-6z" fill="currentColor" opacity="0.6"/></svg>
					安装 Firefox 插件
				</a>
			</div>
			<div class="extension-install-note">
				<strong>Chrome:</strong> 下载 .zip 后解压，打开 <code>chrome://extensions</code>，开启开发者模式，点击"加载已解压的扩展程序"选择解压目录<br>
				<strong>Firefox:</strong> 点击按钮弹出安装提示，如未弹出请用新窗口打开链接或从 <code>about:addons</code> 安装
			</div>
		</div>
		<div class="card">
			<h2>Linux 安装</h2>
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">在 Linux 服务器执行以下命令自动安装，使用 systemd 用户级服务 + ETag 轮询，每 30 秒检查一次更新</p>
			<div class="script-config">
				<div class="script-field">
					<label>配置文件路径</label>
					<input type="text" id="script-config-path" value="/etc/mihomo/config.yaml" onchange="generateAutoScript()" />
				</div>
			</div>
			<pre id="auto-update-script" class="script-block"></pre>
			<button class="btn-primary" onclick="copyAutoScript()">复制命令</button>
		</div>`

	window._subUrl = subUrl
	generateAutoScript()
}

export function generateAutoScript() {
	const configPath = document.getElementById('script-config-path')?.value || '/etc/mihomo/config.yaml'
	const subUrl = window._subUrl || ''
	const cmd = `curl -sL ${location.origin}/install.sh | bash -s -- "${configPath}" "${subUrl}"`
	const pre = document.getElementById('auto-update-script')
	if (pre) pre.textContent = cmd
}

export function copyAutoScript() {
	const pre = document.getElementById('auto-update-script')
	if (pre) {
		navigator.clipboard.writeText(pre.textContent).then(() => toast('命令已复制', 'success'))
	}
}

export function copySubUrl() {
	const input = document.getElementById('sub-url')
	input.select()
	navigator.clipboard.writeText(input.value).then(() => toast('已复制', 'success'))
}

export async function rotateKey() {
	if (!confirm('确定轮换订阅 Key？现有链接将立即失效。')) return
	const res = await API.post('/api/access-key/rotate')
	document.getElementById('sub-url').value = `${location.origin}/sub/${res.key}`
	window._subUrl = `${location.origin}/sub/${res.key}`
	generateAutoScript()
	toast('Key 已更新', 'success')
}
