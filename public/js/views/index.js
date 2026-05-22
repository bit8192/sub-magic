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

	const visibleSubscriptionKey = keyRes.subscriptionKey || ''
	const visibleApiKey = keyRes.apiKey || ''
	const subUrl = visibleSubscriptionKey ? `${location.origin}/sub/${visibleSubscriptionKey}` : ''
	const subscriptionVisible = !!visibleSubscriptionKey
	const apiVisible = !!visibleApiKey
	const subscriptionPresent = !!keyRes.subscriptionKeyPresent
	const apiPresent = !!keyRes.apiKeyPresent
	const subscriptionHint = subscriptionVisible
		? ''
		: '尚未生成订阅 Key。'
	const apiHint = apiVisible
		? ''
		: (apiPresent ? '服务端仅保存哈希，现有 API Key 不可回显；如需查看，请轮换生成新 Key。' : '尚未生成 API Key。')

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
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">订阅客户端只应使用订阅 Key。${subscriptionHint}</p>
			<div class="key-display">
				<input type="text" id="sub-url" readonly value="${subUrl}" placeholder="${subscriptionPresent ? '轮换后可查看新的订阅链接' : '点击生成订阅 Key'}" />
				<button class="btn-primary" onclick="copySubUrl()">复制</button>
				<button class="btn-warning" onclick="rotateSubscriptionKey()">${subscriptionPresent ? '轮换订阅 Key' : '生成订阅 Key'}</button>
			</div>
		</div>
		<div class="card">
			<h2>API Key</h2>
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">浏览器插件调用远程接口时使用独立的 API Key，通过 <code>Authorization: Bearer &lt;api-key&gt;</code> 发送。${apiHint}</p>
			<div class="key-display">
				<input type="text" id="api-key" readonly value="${visibleApiKey}" placeholder="${apiPresent ? '轮换后可查看新的 API Key' : '点击生成 API Key'}" />
				<button class="btn-primary" onclick="copyApiKey()">复制</button>
				<button class="btn-warning" onclick="rotateApiKey()">${apiPresent ? '轮换 API Key' : '生成 API Key'}</button>
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
			<div class="extension-install-note" style="margin-bottom:12px">
				<strong>配置项：</strong><br>
				Sub Magic 地址：<code>${esc(location.origin)}</code><br>
				API Key：上方的 <code>API Key</code>
			</div>
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
			<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
			在 Linux 服务器执行以下命令自动安装，使用 systemd 定时器配合 ETag 长轮询持续30秒等待配置变化并更新配置。<br/>
			用户级服务: 适合配置文件由当前用户可读写的常规部署。<br/>
			root系统服务: 适合发行版将 Mihomo 运行目录隔离到 <code>/var/lib/mihomo</code> 的场景。
			</p>
			<div class="script-config">
				<div class="script-field script-field-mode">
					<label>安装模式</label>
					<select id="script-install-mode" onchange="generateAutoScript()">
						<option value="user">用户级服务</option>
						<option value="root">root 系统服务</option>
					</select>
				</div>
				<div class="script-field script-field-path">
					<label>配置文件路径</label>
					<input type="text" id="script-config-path" value="/etc/mihomo/config.yaml" onchange="generateAutoScript()" />
				</div>
			</div>
			<label class="script-label">安装命令</label>
			<pre id="auto-update-script" class="script-block"></pre>
			<button class="btn-primary script-copy-btn" onclick="copyAutoScript()">复制命令</button>
			<label class="script-label">卸载命令</label>
			<pre id="auto-uninstall-script" class="script-block"></pre>
			<button class="btn-warning" onclick="copyUninstallScript()">复制卸载命令</button>
		</div>`

	window._subUrl = subUrl
	generateAutoScript()
}

export function generateAutoScript() {
	const installMode = document.getElementById('script-install-mode')?.value || 'user'
	const configPath = document.getElementById('script-config-path')?.value || '/etc/mihomo/config.yaml'
	const subUrl = window._subUrl || ''
	const isRoot = installMode === 'root'
	const installCmd = isRoot
		? `curl -sL ${location.origin}/install-root.sh | sudo bash -s -- "${configPath}" "${subUrl}"`
		: `curl -sL ${location.origin}/install.sh | bash -s -- "${configPath}" "${subUrl}"`
	const uninstallCmd = isRoot
		? 'sudo systemctl disable --now sub-magic.timer && sudo rm -f /etc/systemd/system/sub-magic.service /etc/systemd/system/sub-magic.timer /usr/local/bin/sub-magic && sudo systemctl daemon-reload'
		: 'systemctl --user disable --now sub-magic.timer && rm -f ~/.config/systemd/user/sub-magic.service ~/.config/systemd/user/sub-magic.timer ~/.local/bin/sub-magic && systemctl --user daemon-reload'
	const installPre = document.getElementById('auto-update-script')
	const uninstallPre = document.getElementById('auto-uninstall-script')
	if (installPre) installPre.textContent = installCmd
	if (uninstallPre) uninstallPre.textContent = uninstallCmd
}

export function copyAutoScript() {
	const pre = document.getElementById('auto-update-script')
	if (pre) {
		navigator.clipboard.writeText(pre.textContent).then(() => toast('命令已复制', 'success'))
	}
}

export function copyUninstallScript() {
	const pre = document.getElementById('auto-uninstall-script')
	if (pre) {
		navigator.clipboard.writeText(pre.textContent).then(() => toast('卸载命令已复制', 'success'))
	}
}

export function copySubUrl() {
	const input = document.getElementById('sub-url')
	if (!input.value) {
		toast('当前没有可复制的订阅链接，请先生成或轮换订阅 Key', 'warning')
		return
	}
	input.select()
	navigator.clipboard.writeText(input.value).then(() => toast('已复制', 'success'))
}

export function copyApiKey() {
	const input = document.getElementById('api-key')
	if (!input.value) {
		toast('当前没有可复制的 API Key，请先生成或轮换 API Key', 'warning')
		return
	}
	input.select()
	navigator.clipboard.writeText(input.value).then(() => toast('已复制', 'success'))
}

export async function rotateSubscriptionKey() {
	if (!confirm('确定轮换订阅 Key？现有订阅链接将立即失效。')) return
	const res = await API.post('/api/access-key/rotate', { target: 'subscription' })
	const nextSubUrl = `${location.origin}/sub/${res.subscriptionKey}`
	document.getElementById('sub-url').value = nextSubUrl
	window._subUrl = nextSubUrl
	generateAutoScript()
	toast('订阅 Key 已更新', 'success')
}

export async function rotateApiKey() {
	if (!confirm('确定轮换 API Key？现有插件配置将立即失效。')) return
	const res = await API.post('/api/access-key/rotate', { target: 'api' })
	document.getElementById('api-key').value = res.apiKey
	toast('API Key 已更新', 'success')
}
