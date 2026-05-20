document.addEventListener('DOMContentLoaded', async () => {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'])
	if (data.mihomoUrl) document.getElementById('mihomo-url').value = data.mihomoUrl
	if (data.mihomoSecret) document.getElementById('mihomo-secret').value = data.mihomoSecret
	if (data.subMagicUrl) document.getElementById('submagic-url').value = data.subMagicUrl
	if (data.subMagicKey) document.getElementById('submagic-key').value = data.subMagicKey

	document.getElementById('btn-save').addEventListener('click', async () => {
		const mihomoUrl = document.getElementById('mihomo-url').value.trim()
		const mihomoSecret = document.getElementById('mihomo-secret').value.trim()
		const subMagicUrl = document.getElementById('submagic-url').value.trim()
		const subMagicKey = document.getElementById('submagic-key').value.trim()

		await chrome.storage.sync.set({ mihomoUrl, mihomoSecret, subMagicUrl, subMagicKey })
		document.getElementById('save-status').textContent = '已保存'
		setTimeout(() => {
			document.getElementById('save-status').textContent = ''
		}, 2000)
	})
})
