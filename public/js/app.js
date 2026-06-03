import { set401Handler } from './api.js'
import { renderLogin, doLogin, doLogout, checkAuth, onLoggedIn, onLoggedOut, renderSetup, doSetup } from './auth.js'
import { esc, toast, closeModal } from './utils.js'
import { initRouter, switchView } from './router.js'
import { initSync, closeSync, onConfigUpdated } from './sync.js'
import { copySubUrl, copyApiKey, rotateSubscriptionKey, rotateApiKey, copyAutoScript, copyUninstallScript, generateAutoScript } from './views/index.js'
import { showProviderForm, saveProvider, deleteProvider } from './views/providers.js'
// Provider usage functions are assigned to window inside providers.js
import { showGroupForm, saveGroup, deleteGroup } from './views/groups.js'
import { showRuleForm, saveRule, deleteRule, togglePickerBtns, toggleGeoSiteBtn, updateRuleFormUI, openGeositePicker, filterGeosite, toggleGeositeCategory, selectGeosite, openGeoipPicker, filterGeoip, selectGeoip, showRuleFormFromDraft, cancelRuleForm, addLogicalClause, removeLogicalClause, openLogicalGeositePicker, openLogicalGeoipPicker } from './views/rules.js'
import { saveEditor } from './views/editor.js'
import { saveVersion, viewVersion, restoreVersion, deleteVersion } from './views/versions.js'

// Register 401 handler
set401Handler(() => {
  location.hash = '#/login'
  renderLogin()
})

// When logged in, init the router and start real-time sync
onLoggedIn(() => {
  initRouter()
  initSync()

  // Auto-refresh views when config changes remotely
  onConfigUpdated(({ type }) => {
    if (type === 'updated') {
      const hash = location.hash.slice(1) || '/'
      // Refresh data for active views
      if (hash === '/' || hash.startsWith('/index')) {
        import('./views/index.js').then(m => m.loadIndex && m.loadIndex())
      } else if (hash.startsWith('/rules')) {
        import('./views/rules.js').then(m => m.loadRules && m.loadRules())
      } else if (hash.startsWith('/groups')) {
        import('./views/groups.js').then(m => m.loadGroups && m.loadGroups())
      } else if (hash.startsWith('/providers')) {
        import('./views/providers.js').then(m => m.loadProviders && m.loadProviders())
      } else if (hash.startsWith('/versions')) {
        import('./views/versions.js').then(m => m.loadVersions && m.loadVersions())
      } else if (hash.startsWith('/editor')) {
        import('./views/editor.js').then(m => m.loadEditor && m.loadEditor())
      }
    }
  })
})

// Stop sync on logout
onLoggedOut(() => {
  closeSync()
})

// Assign global functions for inline onclick handlers
Object.assign(window, {
  doLogin,
  doLogout,
  doSetup,
  switchView,
  renderLogin,
  renderSetup,
  copySubUrl,
  copyApiKey,
  rotateSubscriptionKey,
  rotateApiKey,
  copyAutoScript,
  copyUninstallScript,
  generateAutoScript,
  showProviderForm,
  saveProvider,
  deleteProvider,
  showGroupForm,
  saveGroup,
  deleteGroup,
  showRuleForm,
  saveRule,
  deleteRule,
  togglePickerBtns,
  toggleGeoSiteBtn,
  updateRuleFormUI,
  openGeositePicker,
  filterGeosite,
  toggleGeositeCategory,
  selectGeosite,
  openGeoipPicker,
  filterGeoip,
  selectGeoip,
  showRuleFormFromDraft,
  cancelRuleForm,
  addLogicalClause,
  removeLogicalClause,
  openLogicalGeositePicker,
  openLogicalGeoipPicker,
  saveEditor,
  saveVersion,
  viewVersion,
  restoreVersion,
  deleteVersion,
  closeModal,
  toast,
  esc,
})

// Boot
checkAuth()
