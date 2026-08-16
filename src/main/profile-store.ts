import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppLanguage, AppTheme, BackgroundTerminalSleepMinutes, CodexProfile, CodexProfileInput, SaveServerProfileInput, ServerProfile, WorkspaceState } from '../shared/types'

type StoredData = {
    profiles: ServerProfile[]
    secrets: Record<string, string>
    settings: { terminalFontSize: number; backgroundTerminalSleepMinutes: BackgroundTerminalSleepMinutes; theme: AppTheme; language: AppLanguage; workspace: WorkspaceState }
}

const DEFAULT_TERMINAL_FONT_SIZE = 14
const DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES: BackgroundTerminalSleepMinutes = 30
const DEFAULT_THEME: AppTheme = 'black'
const DEFAULT_LANGUAGE: AppLanguage = 'en'
const DEFAULT_WORKSPACE: WorkspaceState = { restoreOnLaunch: true, sidebarOpen: true, tmuxTreeOpen: true, sessions: [] }
const EMPTY_DATA: StoredData = { profiles: [], secrets: {}, settings: { terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE, backgroundTerminalSleepMinutes: DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES, theme: DEFAULT_THEME, language: DEFAULT_LANGUAGE, workspace: DEFAULT_WORKSPACE } }

function backgroundTerminalSleepMinutesFrom(value: unknown): BackgroundTerminalSleepMinutes {
    return value === 0 || value === 5 || value === 30 || value === 60 ? value : DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES
}

function workspaceFrom(value: unknown): WorkspaceState {
    if (!value || typeof value !== 'object') return structuredClone(DEFAULT_WORKSPACE)
    const source = value as Partial<WorkspaceState>
    const sessions = Array.isArray(source.sessions)
        ? source.sessions.filter((item): item is WorkspaceState['sessions'][number] => Boolean(item) && typeof item === 'object' && typeof item.profileId === 'string' && typeof item.sessionName === 'string' && typeof item.pinned === 'boolean')
            .slice(0, 100)
        : []
    return {
        restoreOnLaunch: source.restoreOnLaunch !== false,
        sidebarOpen: source.sidebarOpen !== false,
        tmuxTreeOpen: source.tmuxTreeOpen !== false,
        sessions,
        activeSessionKey: typeof source.activeSessionKey === 'string' ? source.activeSessionKey : undefined
    }
}

function codexSecretKey(profileId: string, codexProfileId: string): string {
    return `codex:${profileId}:${codexProfileId}`
}

export class ProfileStore {
    private data: StoredData = structuredClone(EMPTY_DATA)
    private loaded = false

    private get filePath(): string {
        return path.join(app.getPath('userData'), 'servers.json')
    }

    private async load(): Promise<void> {
        if (this.loaded) return
        this.loaded = true
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as Partial<StoredData>
            const storedTerminalFontSize = parsed.settings?.terminalFontSize
            const storedBackgroundTerminalSleepMinutes = parsed.settings?.backgroundTerminalSleepMinutes
            const storedTheme = parsed.settings?.theme
            const storedLanguage = parsed.settings?.language
            this.data = {
                profiles: Array.isArray(parsed.profiles)
                    ? parsed.profiles.map((profile) => ({
                        ...profile,
                        codexProfiles: Array.isArray(profile.codexProfiles) ? profile.codexProfiles : []
                    }))
                    : [],
                secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {},
                settings: {
                    terminalFontSize: typeof storedTerminalFontSize === 'number' && Number.isInteger(storedTerminalFontSize) && storedTerminalFontSize >= 10 && storedTerminalFontSize <= 24
                        ? storedTerminalFontSize
                        : DEFAULT_TERMINAL_FONT_SIZE,
                    backgroundTerminalSleepMinutes: backgroundTerminalSleepMinutesFrom(storedBackgroundTerminalSleepMinutes),
                    theme: storedTheme === 'black' || storedTheme === 'gray' || storedTheme === 'light' ? storedTheme : DEFAULT_THEME,
                    language: storedLanguage === 'zh' || storedLanguage === 'en' ? storedLanguage : DEFAULT_LANGUAGE,
                    workspace: workspaceFrom(parsed.settings?.workspace)
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    private async persist(): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    }

    async list(): Promise<ServerProfile[]> {
        await this.load()
        return [...this.data.profiles].sort((a, b) => a.name.localeCompare(b.name))
    }

    async get(profileId: string): Promise<ServerProfile> {
        await this.load()
        const profile = this.data.profiles.find((item) => item.id === profileId)
        if (!profile) throw new Error('服务器配置不存在')
        return profile
    }

    async save(input: SaveServerProfileInput): Promise<ServerProfile> {
        await this.load()
        const rememberSecret = input.authenticationType !== 'agent' && input.rememberSecret
        if (rememberSecret && input.secret && !safeStorage.isEncryptionAvailable()) {
            throw new Error('当前系统的安全凭据存储不可用，请取消“记住凭据”')
        }
        const now = Date.now()
        const current = input.id ? this.data.profiles.find((item) => item.id === input.id) : undefined
        const suppliedCodexProfiles: CodexProfileInput[] = (input.codexProfiles ?? current?.codexProfiles ?? []).map((item) => ({ ...item }))
        const codexProfiles: CodexProfile[] = suppliedCodexProfiles.map(({ id, name, baseUrl, model }) => ({ id, name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim() }))
        const activeCodexProfileId = codexProfiles.some((item) => item.id === input.activeCodexProfileId)
            ? input.activeCodexProfileId
            : codexProfiles.some((item) => item.id === current?.activeCodexProfileId)
                ? current?.activeCodexProfileId
                : codexProfiles[0]?.id
        const profile: ServerProfile = {
            id: current?.id ?? randomUUID(),
            name: input.name.trim(),
            host: input.host.trim(),
            port: input.port,
            username: input.username.trim(),
            authenticationType: input.authenticationType,
            privateKeyPath: input.privateKeyPath?.trim() || undefined,
            agentSocket: input.agentSocket?.trim() || undefined,
            rememberSecret,
            codexProfiles,
            activeCodexProfileId,
            hostFingerprint: current?.hostFingerprint,
            createdAt: current?.createdAt ?? now,
            updatedAt: now
        }

        const index = this.data.profiles.findIndex((item) => item.id === profile.id)
        if (index >= 0) this.data.profiles[index] = profile
        else this.data.profiles.push(profile)

        if (rememberSecret && input.secret) {
            this.data.secrets[profile.id] = safeStorage.encryptString(input.secret).toString('base64')
        } else if (!rememberSecret) {
            delete this.data.secrets[profile.id]
        }

        const suppliedById = new Map(suppliedCodexProfiles.map((item) => [item.id, item]))
        for (const codexProfile of codexProfiles) {
            const apiKey = suppliedById.get(codexProfile.id)?.apiKey?.trim()
            if (!apiKey) continue
            if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统的安全凭据存储不可用，无法保存 Codex API Key')
            this.data.secrets[codexSecretKey(profile.id, codexProfile.id)] = safeStorage.encryptString(apiKey).toString('base64')
        }
        const activeCodexIds = new Set(codexProfiles.map((item) => item.id))
        for (const key of Object.keys(this.data.secrets)) {
            if (key.startsWith(`codex:${profile.id}:`) && !activeCodexIds.has(key.slice(`codex:${profile.id}:`.length))) delete this.data.secrets[key]
        }
        await this.persist()
        return profile
    }

    async secret(profileId: string): Promise<string | undefined> {
        await this.load()
        const encoded = this.data.secrets[profileId]
        if (!encoded) return undefined
        try {
            return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
        } catch {
            return undefined
        }
    }

    async terminalFontSize(): Promise<number> {
        await this.load()
        return this.data.settings.terminalFontSize
    }

    async setTerminalFontSize(fontSize: number): Promise<number> {
        await this.load()
        this.data.settings.terminalFontSize = fontSize
        await this.persist()
        return fontSize
    }

    async backgroundTerminalSleepMinutes(): Promise<BackgroundTerminalSleepMinutes> {
        await this.load()
        return this.data.settings.backgroundTerminalSleepMinutes
    }

    async setBackgroundTerminalSleepMinutes(minutes: BackgroundTerminalSleepMinutes): Promise<BackgroundTerminalSleepMinutes> {
        await this.load()
        this.data.settings.backgroundTerminalSleepMinutes = minutes
        await this.persist()
        return minutes
    }

    async theme(): Promise<AppTheme> {
        await this.load()
        return this.data.settings.theme
    }

    async setTheme(theme: AppTheme): Promise<AppTheme> {
        await this.load()
        this.data.settings.theme = theme
        await this.persist()
        return theme
    }

    async language(): Promise<AppLanguage> {
        await this.load()
        return this.data.settings.language
    }

    async setLanguage(language: AppLanguage): Promise<AppLanguage> {
        await this.load()
        this.data.settings.language = language
        await this.persist()
        return language
    }

    async workspace(): Promise<WorkspaceState> {
        await this.load()
        return structuredClone(this.data.settings.workspace)
    }

    async setWorkspace(workspace: WorkspaceState): Promise<WorkspaceState> {
        await this.load()
        this.data.settings.workspace = workspaceFrom(workspace)
        await this.persist()
        return structuredClone(this.data.settings.workspace)
    }

    async codexSecret(profileId: string, codexProfileId: string): Promise<string | undefined> {
        await this.load()
        const encoded = this.data.secrets[codexSecretKey(profileId, codexProfileId)]
        if (!encoded) return undefined
        try {
            return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
        } catch {
            return undefined
        }
    }

    async setActiveCodexProfile(profileId: string, codexProfileId: string): Promise<void> {
        await this.load()
        const profile = await this.get(profileId)
        if (!profile.codexProfiles.some((item) => item.id === codexProfileId)) throw new Error('Codex 配置不存在')
        profile.activeCodexProfileId = codexProfileId
        profile.updatedAt = Date.now()
        await this.persist()
    }

    async trustHost(profileId: string, fingerprint: string): Promise<void> {
        await this.load()
        const profile = await this.get(profileId)
        profile.hostFingerprint = fingerprint
        profile.updatedAt = Date.now()
        await this.persist()
    }

    async remove(profileId: string): Promise<void> {
        await this.load()
        this.data.profiles = this.data.profiles.filter((item) => item.id !== profileId)
        delete this.data.secrets[profileId]
        for (const key of Object.keys(this.data.secrets)) {
            if (key.startsWith(`codex:${profileId}:`)) delete this.data.secrets[key]
        }
        await this.persist()
    }
}
