chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'], data => {
		if (!data.mihomoUrl) chrome.storage.sync.set({ mihomoUrl: '' })
		if (!data.mihomoSecret) chrome.storage.sync.set({ mihomoSecret: '' })
		if (!data.subMagicUrl) chrome.storage.sync.set({ subMagicUrl: '' })
		if (!data.subMagicKey) chrome.storage.sync.set({ subMagicKey: '' })
	})
})
