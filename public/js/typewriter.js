/**
 * 终端打字机效果
 * - 标题（h1/h2/h3）：逐字符出现，28~45ms/字，标点后停顿 120ms，方块光标 ▊ 硬切换闪烁
 * - 输入框占位符：打字机循环（输入/聚焦时暂停）
 */

const PUNCTUATION = '，。！？；：、,.!?;:…）》」』)]'
const TYPE_MIN = 28
const TYPE_MAX = 45
const PUNCT_PAUSE = 120

function randomDelay() {
	return TYPE_MIN + Math.random() * (TYPE_MAX - TYPE_MIN)
}

function typeTitle(el, keepCursor = false) {
	const text = el.textContent
	if (!text) return
	el.dataset.twDone = '1'
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

	el.textContent = ''
	const textNode = document.createTextNode('')
	const cursor = document.createElement('span')
	cursor.className = 'tw-cursor'
	cursor.textContent = '▊'
	el.append(textNode, cursor)

	let i = 0
	;(function step() {
		if (el._twCancelled) { el.textContent = text; return }
		if (i >= text.length) {
			if (!keepCursor) setTimeout(() => cursor.remove(), 2000)
			return
		}
		const ch = text[i++]
		textNode.data = text.slice(0, i)
		el._twTimer = setTimeout(step, PUNCTUATION.includes(ch) ? PUNCT_PAUSE : randomDelay())
	})()
}

function animatePlaceholder(input, startDelay) {
	const original = input.getAttribute('placeholder')
	if (!original || input.dataset.phDone) return
	input.dataset.phDone = '1'
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
	if (input.readOnly) return // 只读展示框保持语义占位符

	let i = 0
	let dir = 1
	let holdUntil = 0
	let started = false

	function tick() {
		if (!document.body.contains(input)) return
		if (input.value || document.activeElement === input) {
			input.setAttribute('placeholder', original)
			setTimeout(tick, 800)
			return
		}
		const now = performance.now()
		if (!started && now < startDelay) {
			setTimeout(tick, startDelay - now)
			started = true
			return
		}
		if (now < holdUntil) {
			setTimeout(tick, 120)
			return
		}
		if (dir > 0) {
			i++
			input.setAttribute('placeholder', original.slice(0, i) + '▊')
			if (i >= original.length) {
				dir = -1
				holdUntil = now + 2000
			}
			setTimeout(tick, randomDelay())
		} else {
			i--
			input.setAttribute('placeholder', original.slice(0, i) + (i > 0 ? '▊' : ''))
			if (i <= 0) {
				dir = 1
				holdUntil = now + 600
			}
			setTimeout(tick, 16)
		}
	}
	tick()
}

function enhance(root) {
	root.querySelectorAll('h1:not([data-tw-done]), h2:not([data-tw-done]), h3:not([data-tw-done])').forEach(el => {
		typeTitle(el, el.matches('h1'))
	})
	root.querySelectorAll('input[placeholder]:not([data-ph-done])').forEach(el => {
		animatePlaceholder(el, Math.random() * 2400)
	})
}

export function initTypewriter() {
	const app = document.getElementById('app')
	if (!app) return
	enhance(app)

	const observer = new MutationObserver(() => enhance(app))
	observer.observe(app, { childList: true, subtree: true })
}
