document.addEventListener('DOMContentLoaded', async () => {
	const [data, proxyState] = await Promise.all([
		chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey', 'proxyIsolation']),
		chrome.runtime.sendMessage({ type: 'PROXY_GET_STATE' }),
	])
	if (data.mihomoUrl) document.getElementById('mihomo-url').value = data.mihomoUrl
	if (data.mihomoSecret) document.getElementById('mihomo-secret').value = data.mihomoSecret
	if (data.subMagicUrl) document.getElementById('submagic-url').value = data.subMagicUrl
	if (data.subMagicKey) document.getElementById('submagic-key').value = data.subMagicKey

	const isolationCheckbox = document.getElementById('proxy-isolation')
	const isolationHint = document.getElementById('proxy-isolation-hint')
	const isolationSupported = !!proxyState?.browser?.supportsIsolation

	isolationCheckbox.checked = isolationSupported ? data.proxyIsolation !== false : false
	isolationCheckbox.disabled = !isolationSupported
	isolationHint.textContent = isolationSupported
		? '开启后，每个标签页可分别选择代理方式和代理授权用户。'
		: '当前浏览器不支持按标签页代理隔离；所有标签页将共享同一套代理配置。'

	document.querySelectorAll('.toggle-visibility').forEach((button) => {
		button.addEventListener('click', () => {
			const input = document.getElementById(button.dataset.target)
			const isPassword = input.type === 'password'
			input.type = isPassword ? 'text' : 'password'
			button.textContent = isPassword ? '隐藏' : '显示'
		})
	})

	document.getElementById('btn-save').addEventListener('click', async () => {
		const mihomoUrl = document.getElementById('mihomo-url').value.trim()
		const mihomoSecret = document.getElementById('mihomo-secret').value.trim()
		const subMagicUrl = document.getElementById('submagic-url').value.trim()
		const subMagicKey = document.getElementById('submagic-key').value.trim()
		const proxyIsolation = isolationSupported ? isolationCheckbox.checked : false

		await chrome.storage.sync.set({ mihomoUrl, mihomoSecret, subMagicUrl, subMagicKey, proxyIsolation })
		document.getElementById('save-status').textContent = '已保存'
		setTimeout(() => {
			document.getElementById('save-status').textContent = ''
		}, 2000)
	})
})
