export function esc(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

export function toast(msg, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

export function showModal(html) {
  closeModal()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">${html}</div>`
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal() })
  document.body.appendChild(overlay)
}

export function closeModal() {
  const el = document.getElementById('modal-overlay')
  if (el) el.remove()
}
