import defaults from "./defaults.js"

const ProcrastabsManager = {
	tabs: [],
	bypassSync: false,

	config: {
		badgeBaseColor: defaults.badge.baseColor,
		badgeCountdownColor: defaults.badge.countdownColor,
		badgeCountdownEnabled: defaults.badge.countdownEnabled,
		maxTabs: defaults.maxTabs.value,
		maxTabsEnabled: defaults.maxTabs.enabled,
		countdown: defaults.countdown.value,
		countdownEnabled: defaults.countdown.enabled,
		closeDuplicates: defaults.closeDuplicates,
	},

	async init() {
		const tabs = await this.queryTabs()
		const activeTab = await this.queryActiveTab()
		const config = await this.getConfigFromStorage()

		const { tabs: storageTabs } = config
		let storageTab

		if (!config.maxTabs) {
			config.maxTabs = tabs.length
		} else if (config.countdownEnabled && tabs.length > config.maxTabs) {
			config.maxTabsEnabled = false
			config.countdownEnabled = false
		}

		this.tabs = tabs.map((currentTab) => {
			if (storageTabs) {
				storageTab = storageTabs.find((sTab) => sTab.id === currentTab.id)
			}

			const tab = storageTab || currentTab

			if (tab.activeAt) {
				// session was closed before resetting tab activation timestamp
				tab.timeActive += Date.now() - tab.activeAt
				tab.activeAt = null
			}

			if (activeTab) {
				const { id: activeTabId, windowId: activetWindowId } = activeTab
				if (tab.id === activeTabId && tab.windowId === activetWindowId) {
					tab.activeAt = Date.now()
				}
			}

			if (storageTab) {
				return tab
			}

			return {
				...tab,
				createdAt: Date.now(),
				timeActive: 0,
			}
		})

		this.config = { ...this.config, ...config }

		console.log("tabs: ", this.tabs)
		console.log("config: ", this.config)

		await this.syncWithClient()

		this.updateBadge()
		this.setTabsListeners()
		this.setWindowsListeners()
		this.setStorageSyncListener()

		if (config.countdownEnabled && this.tabs.length === this.config.maxTabs) {
			this.startCountdown()
			this.updateBadge()
		}
	},

	async queryTabs() {
		try {
			const tabs = await chrome.tabs.query({})
			return tabs
		} catch (e) {
			throw new Error(e.message)
		}
	},

	async queryActiveTab() {
		try {
			const [tab] = await chrome.tabs.query({
				active: true,
				lastFocusedWindow: true,
			})
			return tab
		} catch (e) {
			console.error(e)
		}
	},

	async getConfigFromStorage() {
		try {
			const config = await chrome.storage.sync.get([
				"tabs",
				"maxTabs",
				"maxTabsEnabled",
				"countdown",
				"countdownEnabled",
				"closeDuplicates",
			])
			return config
		} catch (e) {
			console.error(e)
		}
	},

	setTabsListeners() {
		chrome.tabs.onCreated.addListener((tab) => {
			console.log("on created ", tab.id)
			const newTab = {
				...tab,
				createdAt: Date.now(),
				timeActive: 0,
			}

			this.tabs.push(newTab)

			if (
				this.config.maxTabsEnabled &&
				this.tabs.length > this.config.maxTabs
			) {
				this.removeTabsById([newTab.id])
				this.bypassSync = true
			} else {
				if (this.config.closeDuplicates) {
					const duplicateTabs = this.getDuplicateTabsOf(newTab)

					if (duplicateTabs.length) {
						this.removeTabsById(duplicateTabs.map((duplicate) => duplicate.id))
						this.syncTabsWithClient()
						this.updateBadge()
						return
					}
				}

				if (this.config.countdownEnabled && !this.hasTabsLeft()) {
					this.startCountdown()
				}

				this.syncTabsWithClient()
				this.updateBadge()
			}
		})

		chrome.tabs.onUpdated.addListener((tabId, updates) => {
			console.log("on updated ", tabId)
			this.tabs = this.tabs.map((tab) => {
				if (tab.id === tabId) {
					if (updates.url && tab.url && updates.url !== tab.url) {
						// tab changed its url
						tab.createdAt = Date.now()
						tab.activeAt = Date.now()
						tab.timeActive = 0
					}
					return { ...tab, ...updates }
				}
				return tab
			})

			// console.log(this.tabs)
			this.syncTabsWithClient()
		})

		chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
			const { isWindowClosing, windowId } = removeInfo
			console.log("on removed ", tabId, " - wId: ", windowId)
			if (isWindowClosing) {
				this.tabs = this.tabs.filter(
					(tab) => tab.windowId !== windowId && tab.id !== tabId
				)
			} else {
				const removedTabIndex = this.tabs.findIndex((tab) => tab.id === tabId)

				this.tabs.splice(removedTabIndex, 1)
				this.tabs = this.tabs.map((tab) => {
					if (tab.windowId === windowId && tab.index > removedTabIndex) {
						tab.index -= 1
					}
					return tab
				})
			}
			// console.log(this.tabs)

			if (this.config.countdownEnabled && this.hasTabsLeft()) {
				this.stopCountdown()
			}

			if (!this.bypassSync) {
				this.syncTabsWithClient()
				this.updateBadge()
			}

			this.bypassSync = false
		})

		chrome.tabs.onActivated.addListener(async ({ tabId }) => {
			console.log("on activated ", tabId)
			this.updateActivityOnTabChange(tabId)
			this.syncTabsWithClient()
		})

		chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
			const { windowId, fromIndex, toIndex } = moveInfo
			console.log("on moved ", tabId, " - wId: ", windowId)
			this.tabs = this.tabs.map((tab) => {
				if (tab.id === tabId) {
					tab.index = toIndex
				} else if (tab.windowId === windowId && tab.index === toIndex) {
					tab.index = fromIndex
				}
				return tab
			})
			// console.log(this.tabs)
			this.syncTabsWithClient()
		})
	},

	setWindowsListeners() {
		chrome.windows.onFocusChanged.addListener(async (windowId) => {
			console.log("on window focus, wId: ", windowId)
			// console.log(windowId)
			if (windowId === -1) {
				// All Chrome Windows have lost focus
				this.tabs = this.tabs.map((tab) => {
					if (tab.activeAt) {
						tab.timeActive += Date.now() - tab.activeAt
						tab.activeAt = null
					}
					return tab
				})
				this.stopCountdown()
				this.updateBadge()
			} else {
				const activeTab = await this.queryActiveTab()
				if (activeTab) {
					this.updateActivityOnTabChange(activeTab.id)
				}

				if (this.config.countdownEnabled && !this.hasTabsLeft()) {
					this.startCountdown()
					this.updateBadge()
				}
			}

			// console.log(this.tabs)
			this.syncTabsWithClient()
		})
	},

	setStorageSyncListener() {
		chrome.storage.onChanged.addListener((changes) => {
			for (let [key, { newValue }] of Object.entries(changes)) {
				this.config[key] = newValue

				switch (key) {
					case "maxTabs":
						if (this.config.countdownEnabled && !this.hasTabsLeft()) {
							this.startCountdown()
						} else {
							this.stopCountdown()
						}
						this.updateBadge()
						break

					case "maxTabsEnabled":
						this.updateBadge()
						break

					case "countdown":
						if (this.config.countdownEnabled && !this.hasTabsLeft()) {
							this.stopCountdown()
							this.startCountdown()
							this.setBadgeColor(this.config.badgeCountdownColor)
							this.setBadgeText(`${newValue.toString()}m`)
						}
						break

					case "countdownEnabled":
						if (newValue && !this.hasTabsLeft()) {
							this.startCountdown()
							this.updateBadge()
						} else if (!newValue) {
							this.stopCountdown()
							this.updateBadge()
						}
						break

					case "closeDuplicates":
						if (this.config.closeDuplicates && newValue) {
							this.closeDuplicateTabs()
							break
						}

					default:
						break
				}
			}
		})
	},

	updateActivityOnTabChange(tabId) {
		this.tabs = this.tabs.map((tab) => {
			if (tab.id === tabId && !tab.activeAt) {
				// current active tab
				console.log("activate ", tab.id)
				tab.activeAt = Date.now()
			} else if (tab.id !== tabId && tab.activeAt) {
				// previous active tab
				console.log("deactivate ", tab.id)
				tab.timeActive += Date.now() - tab.activeAt
				tab.activeAt = null
			}
			return tab
		})
	},

	startCountdown() {
		let countdownInSeconds = this.config.countdown * 60
		let secondsPast = 0

		this.countdownInterval = setInterval(async () => {
			const minutesRemaining = Math.ceil(
				this.config.countdown - secondsPast / 60
			)
			const secondsRemaining = countdownInSeconds - secondsPast

			if (secondsPast === countdownInSeconds) {
				if (!this.hasTabsLeft()) {
					const activeTab = await this.queryActiveTab()
					if (activeTab) {
						this.removeTabsById([activeTab.id])
					} else {
						this.stopCountdown()
						this.updateBadge()
					}
				}
			} else if (this.config.badgeCountdownEnabled) {
				this.setBadgeColor(this.config.badgeCountdownColor)
				this.setBadgeText(
					secondsRemaining < 60
						? secondsRemaining.toString()
						: `${minutesRemaining.toString()}m`
				)
			}
			secondsPast += 1
		}, 1000)
	},

	stopCountdown() {
		clearInterval(this.countdownInterval)
	},

	removeTabsById(tabIds) {
		chrome.tabs.remove(tabIds)
	},

	updateBadge() {
		const tabsRemaining = this.config.maxTabs - this.tabs.length
		const tabsRemainingText = tabsRemaining === 0 ? "0" : `-${tabsRemaining}`
		const text = this.config.maxTabsEnabled
			? tabsRemainingText
			: this.tabs.length.toString()

		this.setBadgeText(text)
		this.setBadgeColor(this.config.badgeBaseColor)
	},

	setBadgeText(text) {
		chrome.action.setBadgeText({ text })
	},

	setBadgeColor(color) {
		chrome.action.setBadgeBackgroundColor({ color })
	},

	removeExtraPropsFromTabs(tabs) {
		return tabs.map((tab) => ({
			id: tab.id,
			windowId: tab.windowId,
			index: tab.index,
			title: tab.title,
			url: tab.url,
			createdAt: tab.createdAt,
			activeAt: tab.activeAt,
			timeActive: tab.timeActive,
		}))
	},

	async syncTabsWithClient() {
		try {
			const tabs = this.removeExtraPropsFromTabs(this.tabs)
			await chrome.storage.sync.set({ tabs })
		} catch (e) {
			console.error(e)
		}
	},

	async syncWithClient() {
		try {
			const tabs = this.removeExtraPropsFromTabs(this.tabs)
			await chrome.storage.sync.set({
				tabs,
				maxTabs: this.config.maxTabs,
				maxTabsEnabled: this.config.maxTabsEnabled,
				countdown: this.config.countdown,
				countdownEnabled: this.config.countdownEnabled,
				closeDuplicates: this.config.closeDuplicates,
			})
			this.updateBadge()
		} catch (e) {
			console.error(e)
		}
	},

	hasTabsLeft() {
		return this.tabs.length < this.config.maxTabs
	},

	getDuplicateTabsOf(tab) {
		const duplicateTabs = this.tabs.filter((stackTab) => {
			if (
				(!tab || (tab && stackTab.id !== tab.id)) &&
				(stackTab.url === tab.url ||
					(!tab.url && stackTab.url === "chrome://newtab/"))
			) {
				return stackTab
			}
		})

		return duplicateTabs
	},

	closeDuplicateTabs() {
		const uniqueTabs = []
		const duplicateTabs = []

		this.tabs.forEach((stackTab) => {
			if (uniqueTabs.find((uniqueTab) => uniqueTab.url === stackTab.url)) {
				duplicateTabs.push(stackTab)
			} else {
				uniqueTabs.push(stackTab)
			}
		})

		if (duplicateTabs.length) {
			this.removeTabsById(duplicateTabs.map((duplicate) => duplicate.id))
		}
	},
}

ProcrastabsManager.init()

/*
	Start of workaround to "persist" service-worker as Chrome terminates all connections after 5 minutes.
	https://stackoverflow.com/a/66618269
*/
let lifeline

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === "keep-alive") {
		lifeline = port
		setTimeout(forceKeepAlive, 295e3) // 5 minutes minus 5 seconds
		port.onDisconnect.addListener(forceKeepAlive)
	}
})

function forceKeepAlive() {
	lifeline?.disconnect()
	lifeline = null
	keepAlive()
}

async function keepAlive() {
	if (lifeline) return

	for (const tab of await chrome.tabs.query({ url: "*://*/*" })) {
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => chrome.runtime.connect({ name: "keep-alive" }),
			})
			chrome.tabs.onUpdated.removeListener(retryOnTabUpdate)
			return
		} catch (e) {}
	}

	chrome.tabs.onUpdated.addListener(retryOnTabUpdate)
}

async function retryOnTabUpdate(tabId, info, tab) {
	if (info.url && /^(file|https?):/.test(info.url)) {
		keepAlive()
	}
}

keepAlive()
/* End of workaround */
