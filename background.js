import defaults from "./defaults.js"

const ProcrastabsManager = {
	tabs: [],
	tabsCount: 0,
	activeTabId: undefined,
	activeWindowId: undefined,
	bypassSync: false,

	config: {
		badgeBaseColor: defaults.badge.baseColor,
		badgeCountdownColor: defaults.badge.countdownColor,
		badgeCountdownSeconds: defaults.badge.countdownSeconds,
		badgeCountdownEnabled: defaults.badge.countdownEnabled,
		maxTabs: defaults.maxTabs.value,
		maxTabsEnabled: defaults.maxTabs.enabled,
		countdown: defaults.countdown.value,
		countdownEnabled: defaults.countdown.enabled,
		avoidDuplicates: defaults.avoidDuplicates,
	},

	async init() {
		this.tabs = await this.queryTabs()
		this.tabsCount = this.tabs.length

		const config = await this.getConfigFromStorage()

		if (!config.maxTabs) {
			config.maxTabs = this.tabsCount
		} else if (config.countdownEnabled && this.tabsCount > config.maxTabs) {
			config.maxTabsEnabled = false
			config.countdownEnabled = false
		}

		this.config = { ...this.config, ...config }

		this.setTabsListeners()
		this.setStorageSyncListener()

		await this.syncWithClient()

		if (config.countdownEnabled && this.tabsCount === this.config.maxTabs) {
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

	async getConfigFromStorage() {
		try {
			const config = await chrome.storage.sync.get([
				"maxTabs",
				"maxTabsEnabled",
				"countdown",
				"countdownEnabled",
			])
			return config
		} catch (e) {
			console.error(e)
		}
	},

	async getCurrentTab() {
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

	setTabsListeners() {
		chrome.tabs.onCreated.addListener((tab) => {
			this.tabs.push(tab)
			this.tabsCount += 1

			if (this.config.maxTabsEnabled && this.tabsCount > this.config.maxTabs) {
				this.removeTabs([tab.id])
				this.bypassSync = true
			} else {
				if (this.config.avoidDuplicates) {
					const duplicatedTabs = this.getDuplicatedTabs(tab)

					if (duplicatedTabs.length) {
						this.removeTabs(duplicatedTabs.map((duplicate) => duplicate.id))
						return
					}
				}

				if (this.config.countdownEnabled && this.hasMaxOpenTabs()) {
					this.startCountdown()
				}

				this.syncTabsWithClient()
			}
		})

		chrome.tabs.onUpdated.addListener((tabId, updates) => {
			this.tabs = this.tabs.map((tab) => {
				if (tab.id === tabId) {
					return { ...tab, ...updates }
				}
				return tab
			})
		})

		chrome.tabs.onRemoved.addListener((tabId) => {
			this.tabs = this.tabs.filter((stackTab) => stackTab.id !== tabId)
			this.tabsCount -= 1

			if (
				this.config.countdownEnabled &&
				!this.hasMaxOpenTabs() &&
				this.countdownOn
			) {
				this.stopCountdown()
			}

			if (!this.bypassSync) {
				this.syncTabsWithClient()
			}

			this.bypassSync = false
		})

		chrome.tabs.onActivated.addListener((activeInfo) => {
			const { tabId, windowId } = activeInfo

			this.activeTabId = tabId
			this.windowTabId = windowId
		})
	},

	setStorageSyncListener() {
		chrome.storage.onChanged.addListener((changes) => {
			for (let [key, { newValue }] of Object.entries(changes)) {
				this.config[key] = newValue

				switch (key) {
					case "maxTabs":
						if (this.config.countdownEnabled && this.hasMaxOpenTabs()) {
							this.startCountdown()
						} else if (this.countdownOn) {
							this.stopCountdown()
						}
						this.updateBadge()
						break

					case "maxTabsEnabled":
						this.updateBadge()
						break

					case "countdown":
						if (this.config.countdownEnabled && this.hasMaxOpenTabs()) {
							this.stopCountdown()
							this.startCountdown()
							this.updateBadge()
						}
						break

					case "countdownEnabled":
						if (newValue && this.hasMaxOpenTabs()) {
							this.startCountdown()
							this.updateBadge()
						} else if (!newValue && this.countdownOn) {
							this.stopCountdown()
							this.updateBadge()
						}
						break

					default:
						break
				}
			}
		})
	},

	async startCountdown() {
		let countdownInSeconds = this.config.countdown * 60
		let secondsPast = 0

		if (!this.activeTabId) {
			const activeTab = await this.getCurrentTab()

			if (activeTab) {
				this.activeTabId = activeTab.id
			}
		}

		this.countdownOn = true
		this.countdownInterval = setInterval(() => {
			const timeRemaining = countdownInSeconds - secondsPast

			if (secondsPast === countdownInSeconds) {
				if (this.hasMaxOpenTabs() && this.activeTabId) {
					this.removeTabs([this.activeTabId])
				}

				this.stopCountdown()
				this.updateBadge()
			} else if (
				this.config.badgeCountdownEnabled &&
				timeRemaining < this.config.badgeCountdownSeconds
			) {
				this.setBadgeColor(this.config.badgeCountdownColor)
				this.setBadgeText(timeRemaining.toString())
			}
			secondsPast += 1
		}, 1000)
	},

	stopCountdown() {
		clearInterval(this.countdownInterval)
		this.countdownOn = false
	},

	removeTabs(tabIds) {
		chrome.tabs.remove(tabIds)
	},

	updateBadge() {
		const tabsRemaining = this.config.maxTabs - this.tabsCount
		const tabsRemainingText = tabsRemaining === 0 ? "0" : `-${tabsRemaining}`
		const text = this.config.maxTabsEnabled
			? tabsRemainingText
			: this.tabsCount.toString()

		this.setBadgeText(text)
		this.setBadgeColor(this.config.badgeBaseColor)
	},

	setBadgeText(text) {
		chrome.action.setBadgeText({ text })
	},

	setBadgeColor(color) {
		chrome.action.setBadgeBackgroundColor({ color })
	},

	async syncTabsWithClient() {
		try {
			await chrome.storage.sync.set({ tabsCount: this.tabsCount })
			this.updateBadge()
		} catch (e) {
			console.error(e)
		}
	},

	async syncWithClient() {
		try {
			await chrome.storage.sync.set({
				tabsCount: this.tabsCount,
				maxTabs: this.config.maxTabs,
				maxTabsEnabled: this.config.maxTabsEnabled,
				countdown: this.config.countdown,
				countdownEnabled: this.config.countdownEnabled,
				avoidDuplicates: this.config.avoidDuplicates,
			})
			this.updateBadge()
		} catch (e) {
			console.error(e)
		}
	},

	hasMaxOpenTabs() {
		return this.tabsCount === this.config.maxTabs
	},

	getDuplicatedTabs(tab) {
		return this.tabs.filter((stackTab) => {
			if (
				stackTab.id !== tab.id &&
				(stackTab.url === tab.url ||
					(!tab.url && stackTab.url === "chrome://newtab/"))
			) {
				return stackTab
			}
		})
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
