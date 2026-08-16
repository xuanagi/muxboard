import { useEffect, useRef, useState } from 'react'
import type { AppLanguage, AppTheme, AuthenticationType, BackgroundTerminalSleepMinutes, CodexProfileInput, ConnectionStatus, SaveServerProfileInput, ServerProfile, TerminalTab, TmuxPane, TmuxSession, TmuxSnapshot, TmuxWindow, WorkspaceState } from '../../shared/types'
import { TerminalPane } from './TerminalPane'
import { FileManager } from './FileManager'

type ServerDraft = {
    id?: string
    name: string
    host: string
    port: string
    username: string
    authenticationType: AuthenticationType
    privateKeyPath: string
    agentSocket: string
    rememberSecret: boolean
    secret: string
    codexProfiles: CodexProfileInput[]
    activeCodexProfileId?: string
}

type PromptState = {
    title: string
    label?: string
    value?: string
    placeholder?: string
    confirmText?: string
    destructive?: boolean
    secret?: boolean
    replaceModal?: boolean
    onConfirm: (value: string) => Promise<void>
}

type FingerprintState = { profileId: string; fingerprint: string; message: string; secret?: string }
type FileWorkspace = { profileId: string; serverName: string; initialRemotePath?: string }
type StartupRestoreItem = { key: string; serverName: string; sessionName: string; status: 'pending' | 'connecting' | 'restored' | 'manual' | 'failed' }
type TabDropTarget = { tabId: string; position: 'before' | 'after' }

const emptyDraft: ServerDraft = {
    name: '', host: '', port: '22', username: '', authenticationType: 'password',
    privateKeyPath: '', agentSocket: '', rememberSecret: false, secret: '', codexProfiles: []
}

const DEFAULT_TERMINAL_FONT_SIZE = 14
const MIN_TERMINAL_FONT_SIZE = 10
const MAX_TERMINAL_FONT_SIZE = 24
const DEFAULT_THEME: AppTheme = 'black'
const DEFAULT_LANGUAGE: AppLanguage = 'en'
const DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES: BackgroundTerminalSleepMinutes = 30
const SNAPSHOT_POLL_NORMAL_MS = 4_000
const SNAPSHOT_POLL_SLOW_MS = 6_000
const SNAPSHOT_POLL_VERY_SLOW_MS = 10_000
const brandLogo = new URL('./assets/muxboard.svg', import.meta.url).href

function sessionKey(profileId: string, sessionName: string): string {
    return `${profileId}\u0000${sessionName}`
}

const copy = {
    en: { servers: 'SERVERS', theme: 'Theme', sleep: 'Sleep', sleepOff: 'Never', sleep5: 'After 5 min', sleep30: 'After 30 min', sleep60: 'After 1 hour', sleepNow: 'Sleep background terminals now', language: '中文', black: 'Black', gray: 'Gray', light: 'Light', connect: 'Connect', connecting: 'Connecting…', refresh: 'Refresh', screenshot: 'Image', file: 'File', disconnect: 'Disconnect', openSession: 'Open a tmux session', workspace: 'Your remote workspace' },
    zh: { servers: '服务器', theme: '主题', sleep: '休眠', sleepOff: '从不休眠', sleep5: '后台 5 分钟后', sleep30: '后台 30 分钟后', sleep60: '后台 1 小时后', sleepNow: '立即休眠后台终端', language: 'English', black: '黑色', gray: '灰色', light: '浅色', connect: '连接', connecting: '连接中…', refresh: '刷新', screenshot: '截图', file: '文件', disconnect: '断开', openSession: '打开一个 tmux 会话', workspace: '你的远程工作区' }
} as const

function localized(language: AppLanguage, en: string, zh: string): string {
    return language === 'zh' ? zh : en
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
    return String(error)
}

export function App(): React.JSX.Element {
    const initialLayout = window.muxboard.settings.initialLayout()
    const [profiles, setProfiles] = useState<ServerProfile[]>([])
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
    const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
    const [snapshots, setSnapshots] = useState<Record<string, TmuxSnapshot>>({})
    const [tabs, setTabs] = useState<TerminalTab[]>([])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
    const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null)
    const [pinnedSessionKeys, setPinnedSessionKeys] = useState<Set<string>>(() => new Set())
    const [restoreOnLaunch, setRestoreOnLaunch] = useState(true)
    const [startupWorkspace, setStartupWorkspace] = useState<WorkspaceState | null>(null)
    const [startupRestoreItems, setStartupRestoreItems] = useState<StartupRestoreItem[]>([])
    const [startupRestoreVisible, setStartupRestoreVisible] = useState(false)
    const [fileWorkspace, setFileWorkspace] = useState<FileWorkspace | null>(null)
    const [workspaceMode, setWorkspaceMode] = useState<'terminal' | 'files'>('terminal')
    const [terminalFontSize, setTerminalFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE)
    const [theme, setTheme] = useState<AppTheme>(DEFAULT_THEME)
    const [themeMenuOpen, setThemeMenuOpen] = useState(false)
    const [backgroundTerminalSleepMinutes, setBackgroundTerminalSleepMinutes] = useState<BackgroundTerminalSleepMinutes>(DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES)
    const [sleepMenuOpen, setSleepMenuOpen] = useState(false)
    const [language, setLanguage] = useState<AppLanguage>(DEFAULT_LANGUAGE)
    const [serverDraft, setServerDraft] = useState<ServerDraft | null>(null)
    const [prompt, setPrompt] = useState<PromptState | null>(null)
    const [fingerprint, setFingerprint] = useState<FingerprintState | null>(null)
    const [toast, setToast] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(initialLayout.sidebarOpen)
    const [tmuxTreeOpen, setTmuxTreeOpen] = useState(initialLayout.tmuxTreeOpen)
    const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())
    const [expandedWindows, setExpandedWindows] = useState<Set<string>>(() => new Set())
    const [activePaneIds, setActivePaneIds] = useState<Record<string, string>>({})
    const initializedExpansionProfiles = useRef(new Set<string>())
    const tabsRef = useRef<TerminalTab[]>([])
    const attachingSessionsRef = useRef(new Set<string>())
    const refreshingSnapshotProfiles = useRef(new Set<string>())
    const terminalFontSizeRef = useRef(DEFAULT_TERMINAL_FONT_SIZE)
    const terminalFontSizeSaveQueue = useRef(Promise.resolve())
    const statusesRef = useRef<Record<string, ConnectionStatus>>({})
    const manuallyDisconnectedProfiles = useRef(new Set<string>())
    const reconnectingProfiles = useRef(new Set<string>())
    const autoReconnectProfiles = useRef(new Set<string>())
    const workspaceReadyRef = useRef(false)
    const skipStartupRestoreRef = useRef(false)

    const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId)
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const t = <K extends keyof typeof copy.en>(key: K): string => copy[language][key]

    const flash = (message: string): void => {
        setToast(message)
        window.setTimeout(() => setToast((current) => current === message ? null : current), 3200)
    }

    const refreshProfiles = async (): Promise<ServerProfile[]> => {
        const items = await window.muxboard.profiles.list()
        setProfiles(items)
        setSelectedProfileId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null)
        return items
    }

    const refreshSnapshot = async (profileId: string): Promise<void> => {
        if (refreshingSnapshotProfiles.current.has(profileId)) return
        refreshingSnapshotProfiles.current.add(profileId)
        try {
            const snapshot = await window.muxboard.tmux.snapshot(profileId)
            setSnapshots((current) => ({ ...current, [profileId]: snapshot }))
            setActivePaneIds((current) => {
                const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${profileId}\u0000`)))
                for (const session of snapshot.sessions) {
                    const activePane = session.windows.find((windowItem) => windowItem.active)?.panes.find((pane) => pane.active)
                    if (activePane) next[`${profileId}\u0000${session.name}`] = activePane.id
                }
                return next
            })
            if (!initializedExpansionProfiles.current.has(profileId)) {
                initializedExpansionProfiles.current.add(profileId)
                setExpandedSessions((current) => new Set([...current, ...snapshot.sessions.filter((session) => session.windows.some((windowItem) => windowItem.active)).map((session) => session.id)]))
                setExpandedWindows((current) => new Set([...current, ...snapshot.sessions.flatMap((session) => session.windows.filter((windowItem) => windowItem.active).map((windowItem) => windowItem.id))]))
            }
        } finally {
            refreshingSnapshotProfiles.current.delete(profileId)
        }
    }

    const toggleExpanded = (setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void => {
        setExpanded((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const updateTerminalFontSize = (value: number): void => {
        const next = Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value))
        if (next === terminalFontSizeRef.current) return
        terminalFontSizeRef.current = next
        setTerminalFontSize(next)
        terminalFontSizeSaveQueue.current = terminalFontSizeSaveQueue.current
            .catch(() => undefined)
            .then(async () => { await window.muxboard.settings.setTerminalFontSize(next) })
            .catch(() => undefined)
    }

    const updateTheme = (nextTheme: AppTheme): void => {
        setTheme(nextTheme)
        document.documentElement.dataset.theme = nextTheme
        setThemeMenuOpen(false)
        void window.muxboard.settings.setTheme(nextTheme).catch(() => undefined)
    }

    const updateBackgroundTerminalSleep = (minutes: BackgroundTerminalSleepMinutes): void => {
        setBackgroundTerminalSleepMinutes(minutes)
        setSleepMenuOpen(false)
        void window.muxboard.settings.setBackgroundTerminalSleepMinutes(minutes).catch((error) => flash(errorMessage(error)))
    }

    const sleepBackgroundTerminals = async (): Promise<void> => {
        try {
            const count = await window.muxboard.terminal.sleepBackground()
            flash(language === 'zh'
                ? count ? `已休眠 ${count} 个后台终端` : '没有可休眠的后台终端'
                : count ? `${count} background terminal${count === 1 ? '' : 's'} put to sleep` : 'No background terminals to sleep')
        } catch (error) { flash(errorMessage(error)) }
    }

    const toggleLanguage = (): void => {
        const nextLanguage: AppLanguage = language === 'en' ? 'zh' : 'en'
        setLanguage(nextLanguage)
        document.documentElement.lang = nextLanguage === 'zh' ? 'zh-CN' : 'en'
        void window.muxboard.settings.setLanguage(nextLanguage).catch(() => undefined)
    }

    useEffect(() => {
        void refreshProfiles()
        void window.muxboard.settings.terminalFontSize().then((fontSize) => {
            terminalFontSizeRef.current = fontSize
            setTerminalFontSize(fontSize)
        }).catch(() => undefined)
        void window.muxboard.settings.backgroundTerminalSleepMinutes().then(setBackgroundTerminalSleepMinutes).catch(() => undefined)
        void window.muxboard.settings.theme().then((storedTheme) => {
            setTheme(storedTheme)
            document.documentElement.dataset.theme = storedTheme
        }).catch(() => undefined)
        void window.muxboard.settings.language().then((storedLanguage) => {
            setLanguage(storedLanguage)
            document.documentElement.lang = storedLanguage === 'zh' ? 'zh-CN' : 'en'
        }).catch(() => undefined)
        void window.muxboard.settings.workspace().then((workspace) => {
            setRestoreOnLaunch(workspace.restoreOnLaunch)
            setSidebarOpen(workspace.sidebarOpen)
            setTmuxTreeOpen(workspace.tmuxTreeOpen)
            setStartupWorkspace(workspace)
        }).catch(() => {
            workspaceReadyRef.current = true
        })
    }, [])
    useEffect(() => window.muxboard.errors.onError((notice) => {
        const message = notice[language]
        setToast(message)
        window.setTimeout(() => setToast((current) => current === message ? null : current), 5_000)
    }), [language])
    useEffect(() => { tabsRef.current = tabs }, [tabs])
    useEffect(() => { statusesRef.current = statuses }, [statuses])
    useEffect(() => {
        const activeProfileConnected = activeTab ? statuses[activeTab.profileId] === 'connected' : false
        const terminalId = workspaceMode === 'terminal' && activeProfileConnected ? activeTabId ?? undefined : undefined
        void window.muxboard.terminal.setActive(terminalId).catch(() => undefined)
    }, [activeTabId, activeTab?.profileId, statuses[activeTab?.profileId ?? ''], workspaceMode])

    useEffect(() => {
        if (!startupWorkspace || workspaceReadyRef.current || profiles.length === 0) return
        void restoreStartupWorkspace(startupWorkspace)
    }, [startupWorkspace, profiles])

    useEffect(() => {
        if (!workspaceReadyRef.current) return
        const entries = new Map<string, WorkspaceState['sessions'][number]>()
        for (const tab of tabs) entries.set(sessionKey(tab.profileId, tab.sessionName), { profileId: tab.profileId, sessionName: tab.sessionName, pinned: pinnedSessionKeys.has(sessionKey(tab.profileId, tab.sessionName)) })
        for (const key of pinnedSessionKeys) {
            if (entries.has(key)) continue
            const [profileId, sessionName] = key.split('\u0000')
            if (profileId && sessionName) entries.set(key, { profileId, sessionName, pinned: true })
        }
        const activeTab = tabs.find((tab) => tab.id === activeTabId)
        void window.muxboard.settings.setWorkspace({
            restoreOnLaunch,
            sidebarOpen,
            tmuxTreeOpen,
            sessions: [...entries.values()],
            activeSessionKey: activeTab ? sessionKey(activeTab.profileId, activeTab.sessionName) : undefined
        }).catch(() => undefined)
    }, [tabs, activeTabId, pinnedSessionKeys, restoreOnLaunch, sidebarOpen, tmuxTreeOpen])

    const restoreTabs = async (profile: ServerProfile): Promise<void> => {
        const previousTabs = tabsRef.current.filter((tab) => tab.profileId === profile.id)
        for (const previous of previousTabs) {
            const restored = await window.muxboard.terminal.attach(profile.id, previous.sessionName, 120, 36)
            setTabs((current) => current.map((tab) => tab.id === previous.id ? restored : tab))
            setActiveTabId((current) => current === previous.id ? restored.id : current)
        }
    }

    const connect = async (profile: ServerProfile, secret?: string, options: { restoreTabs?: boolean; quiet?: boolean } = {}): Promise<boolean> => {
        if (!options.quiet) setBusy(true)
        setStatuses((current) => ({ ...current, [profile.id]: 'connecting' }))
        try {
            const result = await window.muxboard.ssh.connect(profile.id, secret)
            if (!result.ok && result.code === 'HOST_KEY_UNKNOWN') {
                setStatuses((current) => ({ ...current, [profile.id]: 'disconnected' }))
                setFingerprint({ profileId: profile.id, fingerprint: result.fingerprint, message: result.message, secret })
                return false
            }
            if (!result.ok) throw new Error(result.message)
            setStatuses((current) => ({ ...current, [profile.id]: 'connected' }))
            await refreshSnapshot(profile.id)
            if (options.restoreTabs) await restoreTabs(profile)
            if (!options.quiet) flash(localized(language, `Connected to ${profile.name}`, `已连接 ${profile.name}`))
            return true
        } catch (error) {
            setStatuses((current) => ({ ...current, [profile.id]: 'error' }))
            if (!options.quiet) flash(errorMessage(error))
            return false
        } finally {
            if (!options.quiet) setBusy(false)
        }
    }

    const restoreStartupWorkspace = async (workspace: WorkspaceState): Promise<void> => {
        const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
        const savedSessions = workspace.sessions.filter((item) => profilesById.has(item.profileId))
        setPinnedSessionKeys(new Set(savedSessions.filter((item) => item.pinned).map((item) => sessionKey(item.profileId, item.sessionName))))
        const sessionsToRestore = workspace.restoreOnLaunch ? savedSessions : savedSessions.filter((item) => item.pinned)
        if (sessionsToRestore.length === 0) {
            workspaceReadyRef.current = true
            return
        }

        skipStartupRestoreRef.current = false
        const updateRestoreItem = (key: string, status: StartupRestoreItem['status']): void => {
            setStartupRestoreItems((current) => current.map((item) => item.key === key ? { ...item, status } : item))
        }
        setStartupRestoreItems(sessionsToRestore.map((item) => ({
            key: sessionKey(item.profileId, item.sessionName),
            serverName: profilesById.get(item.profileId)?.name ?? item.profileId,
            sessionName: item.sessionName,
            status: 'pending'
        })))
        setStartupRestoreVisible(true)

        const grouped = new Map<string, Array<{ saved: WorkspaceState['sessions'][number]; order: number }>>()
        for (const [order, saved] of sessionsToRestore.entries()) grouped.set(saved.profileId, [...(grouped.get(saved.profileId) ?? []), { saved, order }])
        const restoreServer = async (profileId: string, sessions: Array<{ saved: WorkspaceState['sessions'][number]; order: number }>): Promise<Array<{ tab: TerminalTab; order: number }>> => {
            const profile = profilesById.get(profileId)
            if (skipStartupRestoreRef.current) return []
            if (!profile || (profile.authenticationType === 'password' && !profile.rememberSecret)) {
                for (const { saved } of sessions) updateRestoreItem(sessionKey(saved.profileId, saved.sessionName), 'manual')
                return []
            }
            for (const { saved } of sessions) updateRestoreItem(sessionKey(saved.profileId, saved.sessionName), 'connecting')
            if (!await connect(profile, undefined, { quiet: true })) {
                for (const { saved } of sessions) updateRestoreItem(sessionKey(saved.profileId, saved.sessionName), 'failed')
                return []
            }

            const restoredForServer: Array<{ tab: TerminalTab; order: number }> = []
            for (let start = 0; start < sessions.length && !skipStartupRestoreRef.current; start += 3) {
                const batch = sessions.slice(start, start + 3)
                const results = await Promise.all(batch.map(async ({ saved, order }) => {
                    try {
                        const tab = await window.muxboard.terminal.attach(profile.id, saved.sessionName, 120, 36)
                        updateRestoreItem(sessionKey(saved.profileId, saved.sessionName), 'restored')
                        return { tab, order }
                    } catch {
                        updateRestoreItem(sessionKey(saved.profileId, saved.sessionName), 'failed')
                        return null
                    }
                }))
                restoredForServer.push(...results.filter((result): result is { tab: TerminalTab; order: number } => result !== null))
            }
            return restoredForServer
        }
        const recovered = (await Promise.all([...grouped.entries()].map(async ([profileId, sessions]) => await restoreServer(profileId, sessions)))).flat()
        const restored = recovered.sort((left, right) => left.order - right.order).map((item) => item.tab)
        tabsRef.current = restored
        setTabs(restored)
        const active = workspace.activeSessionKey ? restored.find((tab) => sessionKey(tab.profileId, tab.sessionName) === workspace.activeSessionKey) : undefined
        setActiveTabId(active?.id ?? restored[0]?.id ?? null)
        if (active) setSelectedProfileId(active.profileId)
        workspaceReadyRef.current = true
        window.setTimeout(() => setStartupRestoreVisible(false), 1200)
    }

    const skipStartupRestore = (): void => {
        skipStartupRestoreRef.current = true
        setStartupRestoreVisible(false)
    }

    const requestConnect = (profile: ServerProfile): void => {
        if ((statusesRef.current[profile.id] ?? 'disconnected') === 'connecting') return
        setSelectedProfileId(profile.id)
        manuallyDisconnectedProfiles.current.delete(profile.id)
        if (profile.authenticationType === 'password' && !profile.rememberSecret) {
            setPrompt({
                title: localized(language, `Connect to ${profile.name}`, `连接 ${profile.name}`),
                label: localized(language, 'SSH password', 'SSH 密码'), secret: true, confirmText: t('connect'),
                onConfirm: async (value) => { await connect(profile, value) }
            })
            return
        }
        void connect(profile)
    }

    const disconnect = async (profileId: string): Promise<void> => {
        manuallyDisconnectedProfiles.current.add(profileId)
        autoReconnectProfiles.current.delete(profileId)
        setSnapshots((current) => {
            const next = { ...current }
            delete next[profileId]
            return next
        })
        await window.muxboard.ssh.disconnect(profileId)
        setStatuses((current) => ({ ...current, [profileId]: 'disconnected' }))
        setTabs((current) => current.filter((tab) => tab.profileId !== profileId))
        setActiveTabId((current) => tabs.find((tab) => tab.id === current)?.profileId === profileId ? null : current)
        if (fileWorkspace?.profileId === profileId) {
            setFileWorkspace(null)
            setWorkspaceMode('terminal')
        }
        flash(localized(language, 'SSH disconnected; remote tasks continue running', 'SSH 已断开，远端任务继续运行'))
    }

    useEffect(() => {
        const checkConnections = async (): Promise<void> => {
            const remoteConnections = await window.muxboard.ssh.status().catch(() => [])
            const remoteStatus = new Map(remoteConnections.map((connection) => [connection.profileId, connection.status]))
            const nextStatuses: Record<string, ConnectionStatus> = { ...statusesRef.current }
            for (const profile of profiles) {
                const next = remoteStatus.get(profile.id) ?? 'disconnected'
                const previous = statusesRef.current[profile.id] ?? 'disconnected'
                if (previous === 'connected' && next !== 'connected' && !manuallyDisconnectedProfiles.current.has(profile.id)) {
                    autoReconnectProfiles.current.add(profile.id)
                }
                nextStatuses[profile.id] = next
            }
            statusesRef.current = nextStatuses
            setStatuses(nextStatuses)

            for (const profile of profiles) {
                if (!autoReconnectProfiles.current.has(profile.id) || manuallyDisconnectedProfiles.current.has(profile.id) || reconnectingProfiles.current.has(profile.id)) continue
                if (profile.authenticationType === 'password' && !profile.rememberSecret) continue
                reconnectingProfiles.current.add(profile.id)
                const restored = await connect(profile, undefined, { restoreTabs: true, quiet: true })
                reconnectingProfiles.current.delete(profile.id)
                if (restored) {
                    autoReconnectProfiles.current.delete(profile.id)
                    flash(localized(language, `Reconnected to ${profile.name}; sessions restored`, `已自动重连 ${profile.name}，会话已恢复`))
                }
            }
        }
        const timer = window.setInterval(() => void checkConnections(), 4000)
        return () => window.clearInterval(timer)
    }, [profiles])

    const serverInput = (draft: ServerDraft): SaveServerProfileInput => ({
        id: draft.id,
        name: draft.name,
        host: draft.host,
        port: Number(draft.port),
        username: draft.username,
        authenticationType: draft.authenticationType,
        privateKeyPath: draft.privateKeyPath || undefined,
        agentSocket: draft.agentSocket || undefined,
        rememberSecret: draft.rememberSecret,
        secret: draft.secret || undefined,
        codexProfiles: draft.codexProfiles,
        activeCodexProfileId: draft.activeCodexProfileId
    })

    const saveServer = async (): Promise<void> => {
        if (!serverDraft) return
        try {
            const saved = await window.muxboard.profiles.save(serverInput(serverDraft))
            await refreshProfiles()
            setSelectedProfileId(saved.id)
            setServerDraft(null)
            flash(localized(language, 'Server profile saved', '服务器配置已保存'))
        } catch (error) { flash(errorMessage(error)) }
    }

    const editServer = (profile: ServerProfile): void => setServerDraft({
        id: profile.id, name: profile.name, host: profile.host, port: String(profile.port), username: profile.username,
        authenticationType: profile.authenticationType, privateKeyPath: profile.privateKeyPath ?? '', agentSocket: profile.agentSocket ?? '',
        rememberSecret: profile.rememberSecret, secret: '',
        activeCodexProfileId: profile.activeCodexProfileId,
        codexProfiles: profile.codexProfiles.map((item) => ({ ...item, apiKey: '' }))
    })

    const removeServer = (profile: ServerProfile, replaceModal = false): void => setPrompt({
        title: localized(language, `Remove ${profile.name}?`, `移除 ${profile.name}？`),
        confirmText: localized(language, 'Remove', '移除'), destructive: true, replaceModal,
        onConfirm: async () => {
            await window.muxboard.profiles.remove(profile.id)
            await refreshProfiles()
            setSnapshots((current) => { const next = { ...current }; delete next[profile.id]; return next })
            if (fileWorkspace?.profileId === profile.id) {
                setFileWorkspace(null)
                setWorkspaceMode('terminal')
            }
            flash(localized(language, 'Server profile removed', '服务器配置已移除'))
        }
    })

    const tmuxAction = async (profileId: string, operation: () => Promise<void>, message: string): Promise<void> => {
        try {
            await operation()
            await refreshSnapshot(profileId)
            flash(message)
        } catch (error) { flash(errorMessage(error)) }
    }

    const attachSession = async (profile: ServerProfile, session: TmuxSession): Promise<void> => {
        const sessionKey = `${profile.id}\u0000${session.name}`
        const existing = tabsRef.current.find((tab) => tab.profileId === profile.id && tab.sessionName === session.name)
        if (existing) { setActiveTabId(existing.id); setWorkspaceMode('terminal'); return }
        if (attachingSessionsRef.current.has(sessionKey)) return
        attachingSessionsRef.current.add(sessionKey)
        try {
            const tab = await window.muxboard.terminal.attach(profile.id, session.name, 120, 36)
            const currentTab = tabsRef.current.find((item) => item.profileId === profile.id && item.sessionName === session.name)
            if (currentTab) {
                if (currentTab.id !== tab.id) await window.muxboard.terminal.close(tab.id)
                setActiveTabId(currentTab.id)
                setWorkspaceMode('terminal')
                return
            }
            const nextTabs = [...tabsRef.current, tab]
            tabsRef.current = nextTabs
            setTabs(nextTabs)
            setActiveTabId(tab.id)
            setWorkspaceMode('terminal')
        } catch (error) { flash(errorMessage(error)) }
        finally { attachingSessionsRef.current.delete(sessionKey) }
    }

    const requestNewTmuxSession = (): void => {
        if (!selectedProfile || status !== 'connected') return
        setPrompt({
            title: language === 'zh' ? '新建 tmux 会话' : 'New tmux session',
            label: language === 'zh' ? '会话名称' : 'Session name',
            placeholder: 'project',
            confirmText: language === 'zh' ? '创建' : 'Create',
            onConfirm: async (value) => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.createSession(selectedProfile.id, value), language === 'zh' ? `已创建 ${value}` : `Created ${value}`)
        })
    }

    const togglePinnedSession = (tab: TerminalTab): void => {
        const key = sessionKey(tab.profileId, tab.sessionName)
        setPinnedSessionKeys((current) => {
            const next = new Set(current)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const saveCodexProfileEdits = async (): Promise<void> => {
        if (!serverDraft) return
        try {
            const saved = await window.muxboard.profiles.save(serverInput(serverDraft))
            await refreshProfiles()
            setSelectedProfileId(saved.id)
            setServerDraft({ ...serverDraft, id: saved.id, activeCodexProfileId: saved.activeCodexProfileId })
            flash(localized(language, 'Codex profile saved', 'Codex 配置已保存'))
        } catch (error) { flash(errorMessage(error)) }
    }

    const closeTab = async (tabId: string): Promise<void> => {
        await window.muxboard.terminal.close(tabId).catch(() => undefined)
        setTabs((current) => {
            const index = current.findIndex((tab) => tab.id === tabId)
            const next = current.filter((tab) => tab.id !== tabId)
            if (activeTabId === tabId) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? null)
            return next
        })
    }

    const upload = async (kind: 'clipboard' | 'file'): Promise<void> => {
        if (!activeTab) return flash(localized(language, 'Open a tmux terminal first', '请先打开一个 tmux 终端'))
        try {
            // The UI snapshot is refreshed on a timer. Fetch again here because a shell or
            // Codex may have changed directory just before the user starts an upload.
            const liveSnapshot = await window.muxboard.tmux.snapshot(activeTab.profileId)
            setSnapshots((current) => ({ ...current, [activeTab.profileId]: liveSnapshot }))
            const activeSession = liveSnapshot.sessions.find((session) => session.name === activeTab.sessionName)
            const activePaneId = activePaneIds[`${activeTab.profileId}\u0000${activeTab.sessionName}`]
            const activePane = activeSession?.windows.flatMap((windowItem) => windowItem.panes).find((pane) => pane.id === activePaneId)
                ?? activeSession?.windows.find((windowItem) => windowItem.active)?.panes.find((pane) => pane.active)
            const destinationDirectory = activePane?.currentPath
            if (kind === 'file' && !destinationDirectory) return flash(localized(language, "Can't determine the current pane's working directory", '无法确定当前 pane 的工作目录'))
            const result = kind === 'clipboard'
                ? await window.muxboard.upload.clipboardImage(activeTab.profileId)
                : await window.muxboard.upload.chooseFile(activeTab.profileId, destinationDirectory)
            if (!result) return
            await window.muxboard.terminal.input(activeTab.id, `${kind === 'file' ? result.localName : result.remotePath} `)
        } catch (error) { flash(errorMessage(error)) }
    }

    const reorderTabs = (sourceId: string, targetId: string, position: TabDropTarget['position']): void => {
        if (sourceId === targetId) return
        setTabs((current) => {
            const sourceIndex = current.findIndex((tab) => tab.id === sourceId)
            const targetIndex = current.findIndex((tab) => tab.id === targetId)
            if (sourceIndex < 0 || targetIndex < 0) return current
            const next = [...current]
            const [source] = next.splice(sourceIndex, 1)
            const adjustedTarget = next.findIndex((tab) => tab.id === targetId)
            next.splice(position === 'before' ? adjustedTarget : adjustedTarget + 1, 0, source)
            tabsRef.current = next
            return next
        })
    }

    const beginTabDrag = (event: React.DragEvent<HTMLButtonElement>, tabId: string): void => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-muxboard-tab', tabId)
        event.dataTransfer.setData('text/plain', tabId)
        setDraggingTabId(tabId)
    }

    const updateTabDropTarget = (event: React.DragEvent<HTMLElement>, targetId: string): void => {
        const sourceId = event.dataTransfer.getData('application/x-muxboard-tab') || draggingTabId
        if (!sourceId || sourceId === targetId) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const bounds = event.currentTarget.getBoundingClientRect()
        setTabDropTarget({ tabId: targetId, position: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' })
    }

    const dropTab = (event: React.DragEvent<HTMLElement>, targetId: string): void => {
        event.preventDefault()
        const sourceId = event.dataTransfer.getData('application/x-muxboard-tab') || draggingTabId
        const bounds = event.currentTarget.getBoundingClientRect()
        const position: TabDropTarget['position'] = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
        if (sourceId) reorderTabs(sourceId, targetId, position)
        setDraggingTabId(null)
        setTabDropTarget(null)
    }

    const appendDraggedTab = (event: React.DragEvent<HTMLElement>): void => {
        event.preventDefault()
        const sourceId = event.dataTransfer.getData('application/x-muxboard-tab') || draggingTabId
        if (sourceId) setTabs((current) => {
            const sourceIndex = current.findIndex((tab) => tab.id === sourceId)
            if (sourceIndex < 0 || sourceIndex === current.length - 1) return current
            const next = [...current]
            const [source] = next.splice(sourceIndex, 1)
            next.push(source)
            tabsRef.current = next
            return next
        })
        setDraggingTabId(null)
        setTabDropTarget(null)
    }

    const openFileManager = async (profile: ServerProfile): Promise<void> => {
        let initialRemotePath: string | undefined
        if (activeTab?.profileId === profile.id) {
            try {
                const liveSnapshot = await window.muxboard.tmux.snapshot(profile.id)
                setSnapshots((current) => ({ ...current, [profile.id]: liveSnapshot }))
                const activeSession = liveSnapshot.sessions.find((session) => session.name === activeTab.sessionName)
                initialRemotePath = activeSession?.windows.find((windowItem) => windowItem.active)?.panes.find((pane) => pane.active)?.currentPath
            } catch { /* The file manager will fall back to the remote home directory. */ }
        }
        setSelectedProfileId(profile.id)
        setFileWorkspace({ profileId: profile.id, serverName: profile.name, initialRemotePath })
        setWorkspaceMode('files')
    }

    const requestFileOverwrite = (targetPath: string, confirm: () => Promise<void>): void => {
        setPrompt({
            title: language === 'zh' ? '目标位置已存在同名文件' : 'A file with the same name already exists',
            label: language === 'zh' ? '目标文件' : 'Target file',
            value: targetPath,
            confirmText: language === 'zh' ? '替换' : 'Replace',
            onConfirm: async () => { await confirm() }
        })
    }

    const saveAndApplyCodex = async (codexProfileId: string): Promise<void> => {
        if (!serverDraft) return
        try {
            const saved = await window.muxboard.profiles.save({ ...serverInput(serverDraft), activeCodexProfileId: codexProfileId })
            await window.muxboard.codex.apply(saved.id, codexProfileId)
            await refreshProfiles()
            setSelectedProfileId(saved.id)
            setServerDraft(null)
            flash(localized(language, 'Default Codex profile changed; new Codex sessions will use it', 'Codex 默认配置已切换；新启动的 Codex 会话会使用它'))
        } catch (error) { flash(errorMessage(error)) }
    }

    const openPane = async (profile: ServerProfile, session: TmuxSession, windowItem: TmuxWindow, pane: TmuxPane): Promise<void> => {
        try {
            await window.muxboard.tmux.selectWindow(profile.id, windowItem.id)
            await window.muxboard.tmux.selectPane(profile.id, pane.id)
            setActivePaneIds((current) => ({ ...current, [`${profile.id}\u0000${session.name}`]: pane.id }))
            await attachSession(profile, session)
            await refreshSnapshot(profile.id)
        } catch (error) { flash(errorMessage(error)) }
    }

    const openWindow = async (profile: ServerProfile, session: TmuxSession, windowItem: TmuxWindow): Promise<void> => {
        try {
            await window.muxboard.tmux.selectWindow(profile.id, windowItem.id)
            const activePane = windowItem.panes.find((pane) => pane.active) ?? windowItem.panes[0]
            if (activePane) {
                await window.muxboard.tmux.selectPane(profile.id, activePane.id)
                setActivePaneIds((current) => ({ ...current, [`${profile.id}\u0000${session.name}`]: activePane.id }))
            }
            await attachSession(profile, session)
            await refreshSnapshot(profile.id)
        } catch (error) { flash(errorMessage(error)) }
    }

    useEffect(() => {
        return window.muxboard.shortcuts.onClipboardImage(() => void upload('clipboard'))
    }, [activeTab])

    useEffect(() => {
        const resetTerminalFontSize = (event: KeyboardEvent): void => {
            if (!activeTab || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key !== '0') return
            event.preventDefault()
            event.stopPropagation()
            updateTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)
        }
        window.addEventListener('keydown', resetTerminalFontSize, true)
        return () => window.removeEventListener('keydown', resetTerminalFontSize, true)
    }, [activeTab?.id])

    useEffect(() => {
        if (!activeTab || statuses[activeTab.profileId] !== 'connected') return
        const profileId = activeTab.profileId
        let timer: number | undefined
        let cancelled = false

        const schedule = (delay: number): void => {
            if (cancelled || document.visibilityState === 'hidden') return
            timer = window.setTimeout(() => void poll(), delay)
        }
        const poll = async (): Promise<void> => {
            if (cancelled || document.visibilityState === 'hidden') return
            const startedAt = performance.now()
            try {
                await refreshSnapshot(profileId)
            } catch {
                // Connection monitoring handles disconnects and recovery. Avoid a
                // repeated toast or unhandled rejection from a background refresh.
            }
            if (cancelled) return
            const elapsed = performance.now() - startedAt
            const nextDelay = elapsed >= 750
                ? SNAPSHOT_POLL_VERY_SLOW_MS
                : elapsed >= 350
                    ? SNAPSHOT_POLL_SLOW_MS
                    : SNAPSHOT_POLL_NORMAL_MS
            schedule(nextDelay)
        }
        const handleVisibilityChange = (): void => {
            if (timer !== undefined) window.clearTimeout(timer)
            timer = undefined
            if (document.visibilityState === 'visible') schedule(250)
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        schedule(SNAPSHOT_POLL_NORMAL_MS)
        return () => {
            cancelled = true
            if (timer !== undefined) window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [activeTab?.id, activeTab?.profileId, statuses[activeTab?.profileId ?? '']])

    const snapshot = selectedProfileId ? snapshots[selectedProfileId] : undefined
    const status = selectedProfileId ? statuses[selectedProfileId] ?? 'disconnected' : 'disconnected'
    const restoredCount = startupRestoreItems.filter((item) => item.status !== 'pending' && item.status !== 'connecting').length
    const restoreStateText = (item: StartupRestoreItem): string => {
        if (language === 'zh') return ({ pending: '等待中', connecting: '连接中', restored: '已恢复', manual: '需手动连接', failed: '失败' } as const)[item.status]
        return ({ pending: 'Waiting', connecting: 'Connecting', restored: 'Restored', manual: 'Manual connection required', failed: 'Failed' } as const)[item.status]
    }
    return (
        <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
            <aside className="sidebar">
                <header className="brand-row">
                    <button className="brand-mark" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={localized(language, 'Toggle sidebar', '切换侧栏')}><img src={brandLogo} alt="" /></button>
                    <div className="brand-copy"><strong>Muxboard</strong><span>REMOTE TMUX DESKTOP</span></div>
                    <button className="icon-button add-server" onClick={() => setServerDraft({ ...emptyDraft })} title={localized(language, 'Add server', '添加服务器')}>＋</button>
                </header>
                <div className="section-label"><span>{t('servers')}</span><span>{profiles.length}</span></div>
                <nav className="server-list">
                    {profiles.length === 0 && <button className="empty-server" onClick={() => setServerDraft({ ...emptyDraft })}>{localized(language, 'Add your first server', '添加第一台服务器')}<br/><small>{localized(language, 'Direct SSH connection; no service to deploy', 'SSH 直连，无需部署服务')}</small></button>}
                    {profiles.map((profile) => {
                        const profileStatus = statuses[profile.id] ?? 'disconnected'
                        return <div key={profile.id} className={`server-row ${selectedProfileId === profile.id ? 'is-selected' : ''} ${profileStatus === 'connecting' ? 'is-connecting' : ''}`}>
                            <button className="server-main" onClick={() => setSelectedProfileId(profile.id)} onDoubleClick={() => requestConnect(profile)}>
                                <span className={`status-dot ${profileStatus}`} />
                                <span className="server-details"><b>{profile.name}</b><small>{profile.username}@{profile.host}:{profile.port}</small></span>
                                {profileStatus === 'connecting' && <span className="server-connection-progress" aria-label={t('connecting')}><i aria-hidden="true">◌</i>{t('connecting')}</span>}
                            </button>
                            <button className="row-menu" onClick={() => editServer(profile)} title={localized(language, 'Edit', '编辑')}>•••</button>
                        </div>
                    })}
                </nav>
                <footer className="sidebar-footer"><div className="sidebar-footer-actions"><button className={`footer-action-button restore-toggle ${restoreOnLaunch ? 'is-active' : ''}`} onClick={() => setRestoreOnLaunch((current) => !current)} title={restoreOnLaunch ? localized(language, 'Restore workspace on startup: on', '启动时恢复工作区：开启') : localized(language, 'Restore workspace on startup: off', '启动时恢复工作区：关闭')}>↺</button><ThemePicker theme={theme} language={language} open={themeMenuOpen} onToggle={() => setThemeMenuOpen((current) => !current)} onSelect={updateTheme} /><SleepPolicyPicker minutes={backgroundTerminalSleepMinutes} language={language} open={sleepMenuOpen} onToggle={() => setSleepMenuOpen((current) => !current)} onSelect={updateBackgroundTerminalSleep} onSleepNow={() => void sleepBackgroundTerminals()} /><button className="footer-action-button" onClick={toggleLanguage} title={localized(language, 'Switch language', '切换语言')}>{t('language')}</button></div></footer>
            </aside>

            <section className="workspace">
                <div className={`content-grid ${tmuxTreeOpen ? '' : 'tmux-collapsed'}`}>
                    <aside className={`tmux-tree ${tmuxTreeOpen ? '' : 'is-collapsed'}`}>
                        <div className="tree-heading">
                            <span>TMUX</span>
                            <div className="tree-heading-actions">
                                {selectedProfile && status === 'connected' && <button className="new-tmux-session-button" onClick={requestNewTmuxSession} title={language === 'zh' ? '新建 tmux 会话' : 'New tmux session'} aria-label={language === 'zh' ? '新建 tmux 会话' : 'New tmux session'}>＋</button>}
                            </div>
                        </div>
                        {status !== 'connected' && <div className="tree-empty"><span>⌁</span><p>{localized(language, 'Connect to a server to load\nyour tmux workspace', '连接服务器后\n读取 tmux 工作区').split('\n').map((line, index) => <>{index > 0 && <br />}{line}</>)}</p></div>}
                        {status === 'connected' && snapshot?.sessions.length === 0 && <button className="tree-empty tree-empty-create" onClick={requestNewTmuxSession}><span>＋</span><p>{language === 'zh' ? '还没有 tmux 会话' : 'No tmux sessions yet'}</p><small>{language === 'zh' ? '点击创建第一个会话' : 'Click to create your first session'}</small></button>}
                        {selectedProfile && snapshot?.sessions.map((session) => <div className="session-block" key={session.id}>
                            <div className="session-row" onDoubleClick={() => void attachSession(selectedProfile, session)}>
                                <button className="session-toggle" onClick={() => toggleExpanded(setExpandedSessions, session.id)} aria-label={`${localized(language, expandedSessions.has(session.id) ? 'Collapse' : 'Expand', expandedSessions.has(session.id) ? '折叠' : '展开')} ${localized(language, 'session', '会话')} ${session.name}`} aria-expanded={expandedSessions.has(session.id)}>{expandedSessions.has(session.id) ? '▾' : '▸'}</button>
                                <button className="session-name" onClick={() => void attachSession(selectedProfile, session)} title={session.name}>{session.name}</button>
                                <span className="attached-count">{session.attached || ''}</span>
                                <button title={localized(language, 'New window', '新建窗口')} onClick={() => setPrompt({ title: localized(language, `New window in ${session.name}`, `在 ${session.name} 新建窗口`), label: localized(language, 'Window name', '窗口名称'), placeholder: 'shell', confirmText: localized(language, 'Create', '创建'), onConfirm: async (value) => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.createWindow(selectedProfile.id, session.name, value), localized(language, 'Window created', '窗口已创建')) })}>＋</button>
                                <button title={localized(language, 'Session actions', '会话操作')} onClick={() => setPrompt({ title: localized(language, `Rename ${session.name}`, `重命名 ${session.name}`), label: localized(language, 'New name', '新名称'), value: session.name, confirmText: localized(language, 'Save', '保存'), onConfirm: async (value) => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.renameSession(selectedProfile.id, session.name, value), localized(language, 'Session renamed', '会话已重命名')) })}>•••</button>
                                <button title={localized(language, 'Delete session', '删除会话')} className="tree-danger" onClick={() => setPrompt({ title: localized(language, `Delete session ${session.name}?`, `删除会话 ${session.name}？`), confirmText: localized(language, 'Delete', '删除'), destructive: true, onConfirm: async () => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.killSession(selectedProfile.id, session.name), localized(language, 'Session deleted', '会话已删除')) })}>×</button>
                            </div>
                            {expandedSessions.has(session.id) && session.windows.map((windowItem) => <div className="window-block" key={windowItem.id}>
                                <div className={`window-row ${activeTab?.profileId === selectedProfile.id && activeTab.sessionName === session.name && windowItem.active ? 'is-active' : ''}`} onDoubleClick={() => void openWindow(selectedProfile, session, windowItem)}>
                                <button className="window-toggle" onClick={() => toggleExpanded(setExpandedWindows, windowItem.id)} aria-label={`${localized(language, expandedWindows.has(windowItem.id) ? 'Collapse' : 'Expand', expandedWindows.has(windowItem.id) ? '折叠' : '展开')} ${localized(language, 'window', '窗口')} ${windowItem.name}`} aria-expanded={expandedWindows.has(windowItem.id)}>{expandedWindows.has(windowItem.id) ? '▾' : '▸'}</button>
                                    <span className="tree-index">{windowItem.index}</span><span className="window-name" title={windowItem.name}>{windowItem.name}</span>
                                {windowItem.alert !== 'none' && <span className={`window-alert ${windowItem.alert}`} title={windowItem.alert === 'bell' ? localized(language, 'Terminal bell; attention needed', '终端响铃，需要注意') : windowItem.alert === 'activity' ? localized(language, 'New terminal output', '有新的终端输出') : localized(language, 'Terminal has been quiet', '终端持续静默')} />}
                                <button title={localized(language, 'Rename window', '重命名窗口')} onClick={() => setPrompt({ title: localized(language, `Rename window ${windowItem.name}`, `重命名窗口 ${windowItem.name}`), label: localized(language, 'New name', '新名称'), value: windowItem.name, confirmText: localized(language, 'Save', '保存'), onConfirm: async (value) => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.renameWindow(selectedProfile.id, windowItem.id, value), localized(language, 'Window renamed', '窗口已重命名')) })}>•••</button>
                                <button title={localized(language, 'Delete window', '删除窗口')} className="tree-danger" onClick={() => setPrompt({ title: localized(language, `Delete window ${windowItem.name}?`, `删除窗口 ${windowItem.name}？`), confirmText: localized(language, 'Delete', '删除'), destructive: true, onConfirm: async () => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.killWindow(selectedProfile.id, windowItem.id), localized(language, 'Window deleted', '窗口已删除')) })}>×</button>
                                </div>
                                {expandedWindows.has(windowItem.id) && windowItem.panes.map((pane) => <div className={`pane-row ${activeTab?.profileId === selectedProfile.id && activeTab.sessionName === session.name && activePaneIds[`${selectedProfile.id}\u0000${session.name}`] === pane.id ? 'is-active' : ''}`} key={pane.id}>
                                    <button className="pane-main" onClick={() => void openPane(selectedProfile, session, windowItem, pane)} title={pane.currentPath}>
                                        <span className="tree-index">{pane.index}</span><span>{pane.currentCommand || 'shell'}</span><small>{pane.width}×{pane.height}</small>
                                    </button>
                                    <button title={localized(language, 'Split left/right', '左右分屏')} onClick={() => void tmuxAction(selectedProfile.id, () => window.muxboard.tmux.splitPane(selectedProfile.id, pane.id, 'horizontal', pane.currentPath), localized(language, 'Pane split left/right', '已左右分屏'))}>↔</button>
                                    <button title={localized(language, 'Split top/bottom', '上下分屏')} onClick={() => void tmuxAction(selectedProfile.id, () => window.muxboard.tmux.splitPane(selectedProfile.id, pane.id, 'vertical', pane.currentPath), localized(language, 'Pane split top/bottom', '已上下分屏'))}>↕</button>
                                    <button title={localized(language, 'Delete pane', '删除 pane')} className="tree-danger" onClick={() => setPrompt({ title: localized(language, `Delete pane ${pane.index}?`, `删除 pane ${pane.index}？`), confirmText: localized(language, 'Delete', '删除'), destructive: true, onConfirm: async () => tmuxAction(selectedProfile.id, () => window.muxboard.tmux.killPane(selectedProfile.id, pane.id), localized(language, 'Pane deleted', 'Pane 已删除')) })}>×</button>
                                </div>)}
                            </div>)}
                        </div>)}
                    </aside>

                    <section className="terminal-workspace">
                        <div className="tab-strip">
                            <button className="sidebar-trigger" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={localized(language, 'Toggle sidebar', '切换侧栏')}>☰</button>
                            <button className="tmux-collapse-button" onClick={() => setTmuxTreeOpen((current) => !current)} aria-label={localized(language, tmuxTreeOpen ? 'Collapse tmux tree' : 'Expand tmux tree', tmuxTreeOpen ? '折叠 tmux 树' : '展开 tmux 树')} title={localized(language, tmuxTreeOpen ? 'Collapse tmux tree' : 'Expand tmux tree', tmuxTreeOpen ? '折叠 tmux 树' : '展开 tmux 树')}>{tmuxTreeOpen ? '‹' : '›'}</button>
                            {tabs.map((tab) => <button key={tab.id} draggable className={`terminal-tab ${workspaceMode === 'terminal' && tab.id === activeTabId ? 'is-active' : ''} ${draggingTabId === tab.id ? 'is-dragging' : ''} ${tabDropTarget?.tabId === tab.id ? `is-drop-${tabDropTarget.position}` : ''}`} onDragStart={(event) => beginTabDrag(event, tab.id)} onDragOver={(event) => updateTabDropTarget(event, tab.id)} onDrop={(event) => dropTab(event, tab.id)} onDragEnd={() => { setDraggingTabId(null); setTabDropTarget(null) }} onClick={() => { setActiveTabId(tab.id); setSelectedProfileId(tab.profileId); setWorkspaceMode('terminal') }}>
                                <span className="terminal-glyph">›_</span><span>{tab.title}</span><i className={`tab-pin ${pinnedSessionKeys.has(sessionKey(tab.profileId, tab.sessionName)) ? 'is-pinned' : ''}`} onClick={(event) => { event.stopPropagation(); togglePinnedSession(tab) }} title={pinnedSessionKeys.has(sessionKey(tab.profileId, tab.sessionName)) ? 'Unpin from startup workspace' : 'Pin to startup workspace'}>{pinnedSessionKeys.has(sessionKey(tab.profileId, tab.sessionName)) ? '★' : '☆'}</i><i onClick={(event) => { event.stopPropagation(); void closeTab(tab.id) }}>×</i>
                            </button>)}
                            {fileWorkspace && <button className={`terminal-tab file-manager-tab ${workspaceMode === 'files' ? 'is-active' : ''}`} onClick={() => { setSelectedProfileId(fileWorkspace.profileId); setWorkspaceMode('files') }}>
                                <span className="terminal-glyph">▣</span><span>{t('file')} / {fileWorkspace.serverName}</span><i onClick={(event) => { event.stopPropagation(); setFileWorkspace(null); setWorkspaceMode('terminal') }}>×</i>
                            </button>}
                            <div className={`tab-spacer ${draggingTabId ? 'is-drop-target' : ''}`} onDragOver={(event) => { if (draggingTabId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTarget(null) } }} onDrop={appendDraggedTab} />
                            <div className="tab-actions">
                                {selectedProfile && status !== 'connected' && <button className="primary-button" disabled={busy || status === 'connecting'} onClick={() => requestConnect(selectedProfile)}>{status === 'connecting' ? t('connecting') : t('connect')}</button>}
                                {selectedProfile && status === 'connected' && <>
                                    <button onClick={() => void refreshSnapshot(selectedProfile.id)}>{t('refresh')}</button>
                                    <button onClick={() => void upload('clipboard')} title="Upload clipboard image and paste its remote path (Alt+V)">{t('screenshot')}</button>
                                    <button onClick={() => void openFileManager(selectedProfile)}>{t('file')}</button>
                                    <button className="disconnect-button" onClick={() => void disconnect(selectedProfile.id)}>{t('disconnect')}</button>
                                </>}
                            </div>
                        </div>
                        <div className="terminal-stage">
                            {tabs.map((tab) => <TerminalPane key={tab.id} tab={tab} visible={workspaceMode === 'terminal' && tab.id === activeTabId} fontSize={terminalFontSize} theme={theme} language={language} onFontSizeDelta={(delta) => updateTerminalFontSize(terminalFontSizeRef.current + delta)} onExit={() => undefined} />)}
                            {fileWorkspace && <div className={`file-manager-host ${workspaceMode === 'files' ? 'is-visible' : ''}`}><FileManager
                                profileId={fileWorkspace.profileId} serverName={fileWorkspace.serverName} initialRemotePath={fileWorkspace.initialRemotePath}
                                language={language} onError={flash} onRequestOverwrite={requestFileOverwrite}
                            /></div>}
                            {workspaceMode === 'terminal' && tabs.length === 0 && <div className="empty-terminal-state">
                                <div className="empty-terminal-symbol" aria-hidden="true"><span>›</span><i>_</i></div>
                                <h1>{selectedProfile ? t('openSession') : t('workspace')}</h1>
                            </div>}
                            {startupRestoreVisible && <div className="startup-restore-overlay" role="status">
                                <div className={`startup-restore-card ${restoredCount < startupRestoreItems.length ? 'is-restoring' : 'is-complete'}`}>
                                    <div className="startup-restore-heading"><span className="button-spinner">↻</span> <strong>{language === 'zh' ? '正在恢复工作区' : 'Restoring workspace…'}</strong><span>{restoredCount} / {startupRestoreItems.length}</span></div>
                                    <div className="startup-restore-progress" aria-hidden="true"><i style={{ width: `${startupRestoreItems.length ? restoredCount / startupRestoreItems.length * 100 : 0}%` }} /></div>
                                    <div className="startup-restore-list">{startupRestoreItems.map((item) => <div className={`startup-restore-row is-${item.status}`} key={item.key}><span className="startup-restore-indicator" /><span title={item.serverName}>{item.serverName}</span><b title={item.sessionName}>{item.sessionName}</b><small>{restoreStateText(item)}</small></div>)}</div>
                                    <button className="startup-restore-skip" onClick={skipStartupRestore}>{language === 'zh' ? '跳过恢复' : 'Skip restore'}</button>
                                </div>
                            </div>}
                        </div>
                    </section>
                </div>
            </section>

            {serverDraft && <ServerDialog language={language} draft={serverDraft} setDraft={setServerDraft} onCancel={() => setServerDraft(null)} onSave={() => void saveServer()} onSaveCodex={() => saveCodexProfileEdits()} onApply={(codexProfileId) => saveAndApplyCodex(codexProfileId)} onRemove={serverDraft.id ? () => { const profile = profiles.find((item) => item.id === serverDraft.id); setServerDraft(null); if (profile) removeServer(profile, true) } : undefined} />}
            {prompt && <PromptDialog language={language} state={prompt} onClose={() => setPrompt(null)} onError={(error) => flash(errorMessage(error))} />}
            {fingerprint && <FingerprintDialog language={language} state={fingerprint} onCancel={() => setFingerprint(null)} onTrust={async () => {
                const state = fingerprint
                setFingerprint(null)
                try { await window.muxboard.ssh.trustHost(state.profileId, state.fingerprint); const profile = profiles.find((item) => item.id === state.profileId); if (profile) await connect(profile, state.secret) } catch (error) { flash(errorMessage(error)) }
            }} />}
            {toast && <div className="toast">{toast}</div>}
        </main>
    )
}

function ThemePicker({ theme, language, open, onToggle, onSelect }: { theme: AppTheme; language: AppLanguage; open: boolean; onToggle: () => void; onSelect: (theme: AppTheme) => void }): React.JSX.Element {
    const options: Array<{ id: AppTheme; label: string }> = [
        { id: 'black', label: copy[language].black }, { id: 'gray', label: copy[language].gray }, { id: 'light', label: copy[language].light }
    ]
    return <div className="theme-picker">
        <button className="theme-trigger footer-action-button" aria-label="Switch theme" aria-expanded={open} title="Switch theme" onClick={onToggle}><span className={`theme-swatch ${theme}`} />{copy[language].theme}</button>
        {open && <div className="theme-menu" role="menu">
            {options.map((option) => <button key={option.id} className={option.id === theme ? 'is-selected' : ''} role="menuitemradio" aria-checked={option.id === theme} onClick={() => onSelect(option.id)}><span className={`theme-swatch ${option.id}`} />{option.label}{option.id === theme && <b>✓</b>}</button>)}
        </div>}
    </div>
}

function SleepPolicyPicker({ minutes, language, open, onToggle, onSelect, onSleepNow }: { minutes: BackgroundTerminalSleepMinutes; language: AppLanguage; open: boolean; onToggle: () => void; onSelect: (minutes: BackgroundTerminalSleepMinutes) => void; onSleepNow: () => void }): React.JSX.Element {
    const options: Array<{ minutes: BackgroundTerminalSleepMinutes; label: string }> = [
        { minutes: 0, label: copy[language].sleepOff }, { minutes: 5, label: copy[language].sleep5 }, { minutes: 30, label: copy[language].sleep30 }, { minutes: 60, label: copy[language].sleep60 }
    ]
    return <div className="theme-picker sleep-policy-picker">
        <button className="theme-trigger footer-action-button" aria-label="Background terminal sleep" aria-expanded={open} title="Background terminal sleep" onClick={onToggle}>☾ {copy[language].sleep}</button>
        {open && <div className="theme-menu sleep-policy-menu" role="menu">
            {options.map((option) => <button key={option.minutes} className={option.minutes === minutes ? 'is-selected' : ''} role="menuitemradio" aria-checked={option.minutes === minutes} onClick={() => onSelect(option.minutes)}>{option.label}{option.minutes === minutes && <b>✓</b>}</button>)}
            <button className="sleep-now-action" role="menuitem" onClick={() => { onToggle(); onSleepNow() }}>⌁ {copy[language].sleepNow}</button>
        </div>}
    </div>
}

function ServerDialog({ language, draft, setDraft, onCancel, onSave, onSaveCodex, onApply, onRemove }: { language: AppLanguage; draft: ServerDraft; setDraft: (draft: ServerDraft) => void; onCancel: () => void; onSave: () => void; onSaveCodex: () => Promise<void>; onApply: (codexProfileId: string) => Promise<void>; onRemove?: () => void }): React.JSX.Element {
    const [expandedCodexIds, setExpandedCodexIds] = useState<Set<string>>(() => new Set())
    const [applyingCodexId, setApplyingCodexId] = useState<string | null>(null)
    const [savingCodexId, setSavingCodexId] = useState<string | null>(null)
    const update = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]): void => setDraft({ ...draft, [key]: value })
    const updateCodex = (id: string, patch: Partial<CodexProfileInput>): void => update('codexProfiles', draft.codexProfiles.map((item) => item.id === id ? { ...item, ...patch } : item))
    const toggleCodex = (id: string): void => setExpandedCodexIds((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
    })
    const addCodex = (): void => {
        const id = crypto.randomUUID()
        setDraft({ ...draft, codexProfiles: [...draft.codexProfiles, { id, name: localized(language, 'New profile', '新配置'), baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: '' }], activeCodexProfileId: draft.activeCodexProfileId ?? id })
        setExpandedCodexIds((current) => new Set([...current, id]))
    }
    const removeCodex = (id: string): void => {
        const next = draft.codexProfiles.filter((item) => item.id !== id)
        setDraft({ ...draft, codexProfiles: next, activeCodexProfileId: draft.activeCodexProfileId === id ? next[0]?.id : draft.activeCodexProfileId })
    }
    const applyCodex = async (id: string): Promise<void> => {
        setApplyingCodexId(id)
        try { await onApply(id) } finally { setApplyingCodexId(null) }
    }
    const saveCodex = async (id: string): Promise<void> => {
        setSavingCodexId(id)
        try { await onSaveCodex() } finally { setSavingCodexId(null) }
    }
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
        <section className="modal server-dialog">
            <div className="modal-kicker">SSH PROFILE</div><h2>{localized(language, draft.id ? 'Edit server' : 'Add server', draft.id ? '编辑服务器' : '添加服务器')}</h2>
            <div className="form-grid">
                <label className="wide">{localized(language, 'Name', '名称')}<input autoFocus value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder={localized(language, 'Development server', '开发服务器')} /></label>
                <label className="host-field">{localized(language, 'Host', '主机')}<input value={draft.host} onChange={(event) => update('host', event.target.value)} placeholder="192.168.1.20" /></label>
                <label>{localized(language, 'Port', '端口')}<input type="number" value={draft.port} onChange={(event) => update('port', event.target.value)} /></label>
                <label className="wide">{localized(language, 'Username', '用户名')}<input value={draft.username} onChange={(event) => update('username', event.target.value)} placeholder="ubuntu" /></label>
                <label className="wide">{localized(language, 'Authentication', '认证方式')}<select value={draft.authenticationType} onChange={(event) => update('authenticationType', event.target.value as AuthenticationType)}><option value="password">{localized(language, 'Password', '密码')}</option><option value="privateKey">{localized(language, 'Private key', '私钥')}</option><option value="agent">SSH Agent</option></select></label>
                {draft.authenticationType === 'privateKey' && <label className="wide">{localized(language, 'Private key path', '私钥路径')}<div className="input-action"><input value={draft.privateKeyPath} onChange={(event) => update('privateKeyPath', event.target.value)} placeholder="~/.ssh/id_ed25519" /><button onClick={async () => { const value = await window.muxboard.profiles.revealPrivateKey(); if (value) update('privateKeyPath', value) }}>{localized(language, 'Browse', '选择')}</button></div></label>}
                {draft.authenticationType === 'agent' && <label className="wide">{localized(language, 'Agent socket', 'Agent 套接字')}<input value={draft.agentSocket} onChange={(event) => update('agentSocket', event.target.value)} placeholder={localized(language, 'Leave blank to use SSH_AUTH_SOCK', '留空使用 SSH_AUTH_SOCK')} /></label>}
                {draft.authenticationType !== 'agent' && <label className="wide">{draft.authenticationType === 'password' ? localized(language, 'Password', '密码') : localized(language, 'Private key passphrase', '私钥口令')}<input type="password" value={draft.secret} onChange={(event) => update('secret', event.target.value)} placeholder={draft.id ? localized(language, 'Leave blank to retain saved credentials', '留空则保留已保存凭据') : localized(language, 'You can enter this when connecting', '可在连接时输入')} /></label>}
                {draft.authenticationType !== 'agent' && <label className="check-row wide"><input type="checkbox" checked={draft.rememberSecret} onChange={(event) => update('rememberSecret', event.target.checked)} /><span>{localized(language, 'Remember credentials with system secure storage', '使用系统安全存储记住凭据')}</span></label>}
            </div>
            <div className="codex-profiles">
                <div className="codex-profiles-heading"><h3>{localized(language, 'Codex profiles', 'Codex 配置')}</h3><button type="button" onClick={addCodex}>＋ {localized(language, 'Add', '添加')}</button></div>
                {draft.codexProfiles.length === 0 && <p className="codex-empty">{localized(language, 'No API provider configured.', '尚未配置 API Provider。')}</p>}
                {draft.codexProfiles.map((item) => {
                    const expanded = expandedCodexIds.has(item.id)
                    const active = draft.activeCodexProfileId === item.id
                    return <div className={`codex-profile-card ${expanded ? 'is-expanded' : ''}`} key={item.id}>
                        <div className="codex-profile-summary">
                            <button type="button" className="codex-profile-main" onClick={() => toggleCodex(item.id)} aria-expanded={expanded} title={localized(language, expanded ? 'Collapse profile' : 'Expand profile', expanded ? '收起配置' : '展开配置')}>
                                <span className="disclosure">{expanded ? '▾' : '▸'}</span><span className="codex-profile-name">{item.name || localized(language, 'Unnamed profile', '未命名配置')}</span><span className="codex-profile-model">{item.model || localized(language, 'No model set', '未设置模型')}</span><span className="codex-profile-url">{item.baseUrl || localized(language, 'No Base URL set', '未设置 Base URL')}</span>
                            </button>
                            <span className={`codex-active-badge ${active ? '' : 'is-empty'}`}>{active ? localized(language, 'Active', '已启用') : ''}</span>
                            <button type="button" className="apply-codex-button" disabled={applyingCodexId !== null} aria-busy={applyingCodexId === item.id} onClick={() => void applyCodex(item.id)}>{applyingCodexId === item.id ? <><span className="button-spinner">↻</span>{localized(language, 'Applying…', '应用中…')}</> : localized(language, 'Apply', '应用')}</button>
                        </div>
                        {expanded && <div className="codex-profile-details">
                            <label>{localized(language, 'Name', '名称')}<input value={item.name} onChange={(event) => updateCodex(item.id, { name: event.target.value })} placeholder={localized(language, 'Work API', '工作 API')} /></label>
                            <label>{localized(language, 'Model', '模型')}<input value={item.model} onChange={(event) => updateCodex(item.id, { model: event.target.value })} placeholder="gpt-5.4" /></label>
                            <label className="wide">Base URL<input value={item.baseUrl} onChange={(event) => updateCodex(item.id, { baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
                            <label className="wide">API Key<input type="password" value={item.apiKey ?? ''} onChange={(event) => updateCodex(item.id, { apiKey: event.target.value })} placeholder={localized(language, 'Leave blank to retain the securely saved key', '留空则保留已安全保存的 Key')} /></label>
                            <div className="codex-profile-detail-actions">
                                <button type="button" className="primary-button" disabled={savingCodexId !== null} onClick={() => void saveCodex(item.id)}>{savingCodexId === item.id ? <><span className="button-spinner">↻</span>{localized(language, 'Saving…', '保存中…')}</> : localized(language, 'Save profile', '保存配置')}</button>
                                <button type="button" className="danger-button" disabled={savingCodexId !== null} onClick={() => removeCodex(item.id)}>{localized(language, 'Delete profile', '删除配置')}</button>
                            </div>
                        </div>}
                    </div>
                })}
            </div>
            <div className="modal-actions">{onRemove && <button className="danger-link" onClick={onRemove}>{localized(language, 'Remove server', '移除服务器')}</button>}<span/><button onClick={onCancel}>{localized(language, 'Cancel', '取消')}</button><button className="primary-button" onClick={onSave}>{localized(language, 'Save', '保存')}</button></div>
        </section>
    </div>
}

function PromptDialog({ language, state, onClose, onError }: { language: AppLanguage; state: PromptState; onClose: () => void; onError: (error: unknown) => void }): React.JSX.Element {
    const [value, setValue] = useState(state.value ?? '')
    const [working, setWorking] = useState(false)
    const submit = async (): Promise<void> => {
        if (state.label && !value.trim()) return
        setWorking(true)
        try { await state.onConfirm(value.trim()); onClose() } catch (error) { onError(error); setWorking(false) }
    }
    return <div className={`modal-backdrop ${state.replaceModal ? 'modal-replacement' : ''}`}><section className={`modal prompt-dialog ${state.replaceModal ? 'modal-replacement-dialog' : ''}`}><div className="modal-kicker">MUXBOARD</div><h2>{state.title}</h2>{state.label && <label>{state.label}<input autoFocus type={state.secret ? 'password' : 'text'} value={value} placeholder={state.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} /></label>}<div className="modal-actions"><span/><button onClick={onClose}>{localized(language, 'Cancel', '取消')}</button><button disabled={working} className={state.destructive ? 'danger-button' : 'primary-button'} onClick={() => void submit()}>{state.confirmText ?? localized(language, 'Confirm', '确认')}</button></div></section></div>
}

function FingerprintDialog({ language, state, onCancel, onTrust }: { language: AppLanguage; state: FingerprintState; onCancel: () => void; onTrust: () => void }): React.JSX.Element {
    return <div className="modal-backdrop"><section className="modal fingerprint-dialog"><div className="modal-kicker">HOST VERIFICATION</div><h2>{localized(language, 'Confirm server identity', '确认服务器身份')}</h2><p>{state.message}</p><code>{state.fingerprint}</code><p className="security-note">{localized(language, 'Compare this with your server administrator or the result of ', '请与服务器管理员或本机 ')}<b>ssh-keygen -lf</b>{localized(language, '. Trust this server only after it matches.', ' 的结果核对。仅在确认无误后信任。')}</p><div className="modal-actions"><span/><button onClick={onCancel}>{localized(language, 'Cancel', '取消')}</button><button className="primary-button" onClick={onTrust}>{localized(language, 'Trust and connect', '信任并连接')}</button></div></section></div>
}
