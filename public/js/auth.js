import { API } from './api.js'

let _onLoggedIn = () => {}
export function onLoggedIn(fn) { _onLoggedIn = fn }

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
