export let currentView = 'index'
export function setCurrentView(v) { currentView = v }

export let groupsData = []
export function setGroupsData(d) { groupsData = d }

export let msAvailable = []
export let msSelectedState = new Set()

export let dragRuleIndex = null
export let rulesData = []
export function setRulesData(d) { rulesData = d }

export let geositeCategories = null
export let geoipCountries = null
