/**
 * 像素粒子背景特效
 * - 2~4px 方块粒子缓慢上浮，正弦横向漂移，透明度呼吸
 * - 偶发单帧闪烁
 * - 鼠标 80px 内轻微排斥
 * - 卡片悬停时增强其周围粒子（更亮、更快）
 */

const COLORS = [
	{ fill: '76, 224, 179', weight: 6 }, // 薄荷绿
	{ fill: '167, 139, 250', weight: 3 }, // 像素紫
	{ fill: '255, 180, 84', weight: 1 }, // 琥珀
]

function pickColor() {
	const total = COLORS.reduce((sum, c) => sum + c.weight, 0)
	let r = Math.random() * total
	for (const c of COLORS) {
		if ((r -= c.weight) < 0) return c.fill
	}
	return COLORS[0].fill
}

export function initFX() {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

	const canvas = document.createElement('canvas')
	canvas.id = 'fx-particles'
	document.body.prepend(canvas)
	const ctx = canvas.getContext('2d')

	let W = 0
	let H = 0
	function resize() {
		W = window.innerWidth
		H = window.innerHeight
		canvas.width = W
		canvas.height = H
		ctx.imageSmoothingEnabled = false
	}
	resize()
	window.addEventListener('resize', resize)

	const mouse = { x: -9999, y: -9999 }
	window.addEventListener('pointermove', e => {
		mouse.x = e.clientX
		mouse.y = e.clientY
	}, { passive: true })
	window.addEventListener('pointerleave', () => {
		mouse.x = -9999
		mouse.y = -9999
	})

	// 悬停中的卡片矩形，用于增强周围粒子
	const hoverRects = []
	document.addEventListener('pointerover', e => {
		const card = e.target && e.target.closest ? e.target.closest('.card, .login-card, .provider-item, .group-card, .rule-item') : null
		if (card) {
			hoverRects.length = 0
			const rect = card.getBoundingClientRect()
			hoverRects.push({ left: rect.left - 60, right: rect.right + 60, top: rect.top - 60, bottom: rect.bottom + 60 })
		}
	})
	document.addEventListener('pointerout', e => {
		if (!e.relatedTarget || !(e.relatedTarget.closest && e.relatedTarget.closest('.card, .login-card, .provider-item, .group-card, .rule-item'))) {
			hoverRects.length = 0
		}
	})

	function spawn(initial = false) {
		return {
			baseX: Math.random() * W,
			y: initial ? Math.random() * H : H + 8,
			size: 2 + Math.floor(Math.random() * 3), // 2 / 3 / 4
			speed: 0.12 + Math.random() * 0.35,
			amp: 6 + Math.random() * 20,
			phase: Math.random() * Math.PI * 2,
			breath: 0.6 + Math.random() * 1.8,
			baseAlpha: 0.25 + Math.random() * 0.45,
			color: pickColor(),
			nextFlicker: performance.now() + 3000 + Math.random() * 9000,
			flickerUntil: 0,
		}
	}

	const COUNT = Math.max(30, Math.min(90, Math.floor((W * H) / 18000)))
	const particles = Array.from({ length: COUNT }, () => spawn(true))

	let running = true
	document.addEventListener('visibilitychange', () => {
		running = !document.hidden
		if (running) requestAnimationFrame(frame)
	})

	function frame(t) {
		if (!running) return
		ctx.clearRect(0, 0, W, H)

		for (const p of particles) {
			// 卡片悬停增强
			let boost = 0
			for (const r of hoverRects) {
				if (p.baseX > r.left && p.baseX < r.right && p.y > r.top && p.y < r.bottom) {
					boost = 1
					break
				}
			}

			p.y -= p.speed * (1 + boost * 2.2)
			if (p.y < -6) Object.assign(p, spawn())

			const x = p.baseX + Math.sin(t / 1400 + p.phase) * p.amp
			const breathe = 0.55 + 0.45 * Math.sin(t / (900 * p.breath) + p.phase)

			// 鼠标 80px 内轻微排斥（临时位移，不改变轨迹）
			let rx = 0
			const dx = x - mouse.x
			const dy = p.y - mouse.y
			const dist = Math.hypot(dx, dy)
			if (dist < 80 && dist > 0.01) {
				rx = (dx / dist) * (80 - dist) * 0.28
			}

			// 偶发单帧闪烁
			if (t > p.nextFlicker) {
				p.flickerUntil = t + 50
				p.nextFlicker = t + 4000 + Math.random() * 8000
			}
			let alpha = p.baseAlpha * breathe + boost * 0.35
			if (t < p.flickerUntil) alpha = 1

			const px = Math.round(x + rx)
			const py = Math.round(p.y)
			ctx.fillStyle = `rgba(${p.color}, ${Math.min(1, alpha).toFixed(3)})`
			ctx.fillRect(px, py, p.size, p.size)
		}

		requestAnimationFrame(frame)
	}
	requestAnimationFrame(frame)
}
