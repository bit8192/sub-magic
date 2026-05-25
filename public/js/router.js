import { renderLogin } from './auth.js'
import { setCurrentView } from './state.js'
import { renderDashboard } from './views/index.js'
import { renderProviders } from './views/providers.js'
import { renderGroups } from './views/groups.js'
import { renderRules } from './views/rules.js'
import { renderEditor } from './views/editor.js'
import { renderVersions } from './views/versions.js'

const ROUTE_MAP = {
  'index': renderDashboard,
  'providers': renderProviders,
  'groups': renderGroups,
  'rules': renderRules,
  'editor': renderEditor,
  'versions': renderVersions,
}

let appRendered = false

export function renderApp() {
  if (appRendered) return
  appRendered = true
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="topbar">
      <h1>Sub Magic</h1>
      <nav>
        <button data-view="index" onclick="switchView('index')">首页</button>
        <button data-view="providers" onclick="switchView('providers')">订阅源</button>
        <button data-view="groups" onclick="switchView('groups')">代理组</button>
        <button data-view="rules" onclick="switchView('rules')">规则</button>
        <button data-view="editor" onclick="switchView('editor')">文本编辑</button>
        <button data-view="versions" onclick="switchView('versions')">历史版本</button>
        <a href="https://github.com/bit8192/sub-magic" target="_blank" rel="noreferrer" class="nav-link">GitHub</a>
      </nav>
      <button class="btn-logout" onclick="doLogout()">登出</button>
    </div>
    <div id="view-container"></div>`
}

export function switchView(view) {
  setCurrentView(view)
  // Update hash without triggering navigation
  if (location.hash !== `#/${view}`) {
    history.replaceState(null, '', `#/${view}`)
  }
  // Highlight nav
  document.querySelectorAll('.topbar nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view)
  })
  const container = document.getElementById('view-container')
  const renderFn = ROUTE_MAP[view]
  if (renderFn && container) {
    renderFn(container)
  }
}

let handling = false

export async function handleHashChange() {
  if (handling) return
  handling = true
  try {
  const hash = location.hash.replace('#/', '') || 'index'
  const view = ROUTE_MAP[hash] ? hash : 'index'
  // Check auth for all routes except login
  try {
    const res = await fetch('/api/check')
    const data = await res.json()
    if (!data.ok) {
      appRendered = false
      renderLogin()
      return
    }
  } catch {
    appRendered = false
    renderLogin()
    return
  }
  if (!appRendered) renderApp()
  switchView(view)
  } finally { handling = false }
}

export function initRouter() {
  window.addEventListener('hashchange', handleHashChange)
  handleHashChange()
}
