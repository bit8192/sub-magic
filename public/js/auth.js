import { API } from './api.js'

let _onLoggedIn = () => {}
export function onLoggedIn(fn) { _onLoggedIn = fn }

async function fetchPasswordStatus() {
  const res = await fetch('/api/password-status')
  const data = await res.json()
  return data.passwordSet
}

export function renderSetup() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <h1>Sub Magic</h1>
        <p>首次使用，请设置管理员密码</p>
        <div class="form-group">
          <label>密码 (至少6位)</label>
          <input type="password" id="setup-password" placeholder="设置管理密码" />
        </div>
        <div class="form-group">
          <label>确认密码</label>
          <input type="password" id="setup-password2" placeholder="再次输入密码" onkeydown="if(event.key==='Enter')doSetup()" />
        </div>
        <button class="btn-primary" onclick="doSetup()" style="width:100%">创建密码</button>
        <div id="setup-error" class="error"></div>
      </div>
    </div>`
}

export async function doSetup() {
  const pwd = document.getElementById('setup-password').value
  const pwd2 = document.getElementById('setup-password2').value
  const errEl = document.getElementById('setup-error')

  if (pwd.length < 6) {
    errEl.textContent = '密码至少需要6位'
    return
  }
  if (pwd !== pwd2) {
    errEl.textContent = '两次密码不一致'
    return
  }

  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    })
    const data = await res.json()
    if (res.ok) {
      _onLoggedIn()
    } else {
      errEl.textContent = data.error || '设置失败'
    }
  } catch {
    errEl.textContent = '网络错误'
  }
}

export function renderLogin() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <h1>Sub Magic</h1>
        <p>Clash 订阅管理工具</p>
        <div class="form-group">
          <label>密码</label>
          <input type="password" id="login-password" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')doLogin()" />
        </div>
        <button class="btn-primary" onclick="doLogin()" style="width:100%">登入</button>
        <div id="login-error" class="error"></div>
      </div>
    </div>`
}

export async function doLogin() {
  const pwd = document.getElementById('login-password').value
  try {
    const res = await API.post('/api/login', { password: pwd })
    if (res.ok) {
      await checkAuth()
    }
  } catch {
    document.getElementById('login-error').textContent = '密码错误'
  }
}

export async function checkAuth() {
  try {
    const passwordSet = await fetchPasswordStatus()
    if (!passwordSet) {
      renderSetup()
      return
    }
    const res = await API.get('/api/check')
    if (res.ok) _onLoggedIn()
    else renderLogin()
  } catch {
    renderLogin()
  }
}

export async function doLogout() {
  await API.post('/api/logout')
  renderLogin()
}
