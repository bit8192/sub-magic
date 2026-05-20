let _on401 = () => {}

export function set401Handler(fn) {
  _on401 = fn
}

export const API = {
  async get(path) {
    const res = await fetch(path)
    if (res.status === 401) { _on401(); throw new Error('unauthorized') }
    return res.json()
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) { _on401(); throw new Error('unauthorized') }
    return res.json()
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) { _on401(); throw new Error('unauthorized') }
    return res.json()
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' })
    if (res.status === 401) { _on401(); throw new Error('unauthorized') }
    return res.json()
  },
}
