import { set401Handler } from './api.js'
import { renderLogin, doLogin, doLogout, checkAuth, onLoggedIn } from './auth.js'
import { esc, toast, closeModal } from './utils.js'
import { initRouter, switchView } from './router.js'
import { copySubUrl, rotateKey, copyAutoScript, generateAutoScript } from './views/index.js'
import { showProviderForm, saveProvider, deleteProvider } from './views/providers.js'
// Provider usage functions are assigned to window inside providers.js
import { showGroupForm, saveGroup, deleteGroup } from './views/groups.js'
import { showRuleForm, saveRule, deleteRule, togglePickerBtns, toggleGeoSiteBtn, updateRuleFormUI, openGeositePicker, filterGeosite, toggleGeositeCategory, selectGeosite, openGeoipPicker, filterGeoip, selectGeoip, showRuleFormFromDraft } from './views/rules.js'
import { saveEditor } from './views/editor.js'
import { saveVersion, viewVersion, restoreVersion, deleteVersion } from './views/versions.js'

// Register 401 handler
set401Handler(() => {
  location.hash = '#/login'
  renderLogin()
})

// When logged in, init the router
onLoggedIn(() => {
  initRouter()
})

// Assign global functions for inline onclick handlers
Object.assign(window, {
  doLogin,
  doLogout,
  switchView,
  renderLogin,
  copySubUrl,
  rotateKey,
  copyAutoScript,
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
