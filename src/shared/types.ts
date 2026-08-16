export type AuthenticationType = 'password' | 'privateKey' | 'agent'
export type AppTheme = 'black' | 'gray' | 'light'
export type AppLanguage = 'en' | 'zh'
export type BackgroundTerminalSleepMinutes = 0 | 5 | 30 | 60

export type CodexProfile = {
    id: string
    name: string
    baseUrl: string
    model: string
}

export type CodexProfileInput = CodexProfile & {
    /** Only accepted while saving; it is encrypted in the main process and never returned to the renderer. */
    apiKey?: string
}

export type ServerProfile = {
    id: string
    name: string
    host: string
    port: number
    username: string
    authenticationType: AuthenticationType
    privateKeyPath?: string
    agentSocket?: string
    rememberSecret: boolean
    codexProfiles: CodexProfile[]
    activeCodexProfileId?: string
    hostFingerprint?: string
    createdAt: number
    updatedAt: number
}

export type SaveServerProfileInput = Omit<ServerProfile, 'id' | 'createdAt' | 'updatedAt' | 'hostFingerprint' | 'codexProfiles'> & {
    id?: string
    secret?: string
    codexProfiles?: CodexProfileInput[]
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ServerConnection = {
    profileId: string
    status: ConnectionStatus
    message?: string
    connectedAt?: number
}

export type ConnectResult =
    | { ok: true; fingerprint: string }
    | { ok: false; code: 'HOST_KEY_UNKNOWN'; fingerprint: string; message: string }
    | { ok: false; code: 'CONNECTION_FAILED'; message: string }

export type TmuxPane = {
    id: string
    index: number
    title: string
    currentCommand: string
    currentPath: string
    pid: number | null
    active: boolean
    dead: boolean
    width: number
    height: number
}

export type TmuxWindow = {
    id: string
    index: number
    name: string
    active: boolean
    layout: string
    alert: 'none' | 'activity' | 'bell' | 'silence'
    panes: TmuxPane[]
}

export type TmuxSession = {
    id: string
    name: string
    attached: number
    createdAt: number
    windows: TmuxWindow[]
}

export type TmuxSnapshot = {
    sessions: TmuxSession[]
    tmuxVersion: string | null
    capturedAt: number
}

export type TerminalTab = {
    id: string
    profileId: string
    serverName: string
    sessionName: string
    title: string
}

export type UploadResult = {
    localName: string
    remotePath: string
    size: number
    mimeType: string
}

export type WorkspaceSession = {
    profileId: string
    sessionName: string
    pinned: boolean
}

export type WorkspaceState = {
    restoreOnLaunch: boolean
    sidebarOpen: boolean
    tmuxTreeOpen: boolean
    sessions: WorkspaceSession[]
    activeSessionKey?: string
}

export type FileManagerEntry = {
    name: string
    path: string
    type: 'file' | 'directory' | 'symlink' | 'other'
    size: number
    modifiedAt: number
}

export type FileManagerListing = {
    path: string
    parentPath: string | null
    entries: FileManagerEntry[]
}

export type FileTransferDirection = 'upload' | 'download'

export type StartFileTransferInput = {
    profileId: string
    direction: FileTransferDirection
    sourcePath: string
    destinationDirectory: string
    overwrite?: boolean
}

export type StartFileTransferResult =
    | { status: 'started'; transferId: string }
    | { status: 'conflict'; targetPath: string }

export type FileTransferEvent = {
    transferId: string
    profileId: string
    direction: FileTransferDirection
    name: string
    sourcePath: string
    targetPath: string
    currentPath?: string
    transferredBytes: number
    totalBytes: number
    status: 'running' | 'completed' | 'cancelled' | 'error'
    error?: string
}

export type TerminalDataEvent = { terminalId: string; data: string }
export type TerminalExitEvent = { terminalId: string; code: number | null; signal?: string }
export type AppErrorNotice = Record<AppLanguage, string>

export type MuxboardDesktopApi = {
    errors: {
        onError(callback: (notice: AppErrorNotice) => void): () => void
    }
    settings: {
        initialLayout(): Pick<WorkspaceState, 'sidebarOpen' | 'tmuxTreeOpen'>
        terminalFontSize(): Promise<number>
        setTerminalFontSize(fontSize: number): Promise<number>
        backgroundTerminalSleepMinutes(): Promise<BackgroundTerminalSleepMinutes>
        setBackgroundTerminalSleepMinutes(minutes: BackgroundTerminalSleepMinutes): Promise<BackgroundTerminalSleepMinutes>
        theme(): Promise<AppTheme>
        setTheme(theme: AppTheme): Promise<AppTheme>
        language(): Promise<AppLanguage>
        setLanguage(language: AppLanguage): Promise<AppLanguage>
        workspace(): Promise<WorkspaceState>
        setWorkspace(workspace: WorkspaceState): Promise<WorkspaceState>
    }
    profiles: {
        list(): Promise<ServerProfile[]>
        save(input: SaveServerProfileInput): Promise<ServerProfile>
        remove(profileId: string): Promise<void>
        revealPrivateKey(): Promise<string | null>
    }
    ssh: {
        connect(profileId: string, secret?: string): Promise<ConnectResult>
        trustHost(profileId: string, fingerprint: string): Promise<void>
        disconnect(profileId: string): Promise<void>
        status(): Promise<ServerConnection[]>
    }
    tmux: {
        snapshot(profileId: string): Promise<TmuxSnapshot>
        createSession(profileId: string, name: string, cwd?: string): Promise<void>
        renameSession(profileId: string, sessionName: string, nextName: string): Promise<void>
        killSession(profileId: string, sessionName: string): Promise<void>
        createWindow(profileId: string, sessionName: string, name: string, cwd?: string): Promise<void>
        renameWindow(profileId: string, windowId: string, name: string): Promise<void>
        killWindow(profileId: string, windowId: string): Promise<void>
        splitPane(profileId: string, paneId: string, direction: 'horizontal' | 'vertical', cwd?: string): Promise<void>
        killPane(profileId: string, paneId: string): Promise<void>
        selectWindow(profileId: string, windowId: string): Promise<void>
        selectPane(profileId: string, paneId: string): Promise<void>
    }
    terminal: {
        attach(profileId: string, sessionName: string, cols: number, rows: number): Promise<TerminalTab>
        input(terminalId: string, data: string): Promise<void>
        resize(terminalId: string, cols: number, rows: number): Promise<void>
        setActive(terminalId?: string): Promise<void>
        sleepBackground(): Promise<number>
        close(terminalId: string): Promise<void>
        onData(callback: (event: TerminalDataEvent) => void): () => void
        onExit(callback: (event: TerminalExitEvent) => void): () => void
    }
    upload: {
        clipboardImage(profileId: string): Promise<UploadResult>
        chooseFile(profileId: string, destinationDirectory?: string): Promise<UploadResult | null>
    }
    files: {
        initialPaths(profileId: string, preferredRemotePath?: string): Promise<{ localPath: string; remotePath: string }>
        listLocal(path: string): Promise<FileManagerListing>
        listRemote(profileId: string, path: string): Promise<FileManagerListing>
        chooseLocalDirectory(): Promise<string | null>
        startTransfer(input: StartFileTransferInput): Promise<StartFileTransferResult>
        cancelTransfer(transferId: string): Promise<void>
        onTransfer(callback: (event: FileTransferEvent) => void): () => void
    }
    codex: {
        apply(profileId: string, codexProfileId: string): Promise<void>
    }
    shortcuts: {
        onClipboardImage(callback: () => void): () => void
    }
    clipboard: {
        text(): Promise<string>
        writeText(text: string): Promise<void>
    }
}
