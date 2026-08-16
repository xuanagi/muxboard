import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ProfileStore } from './profile-store'
import type { AppTheme, WorkspaceState } from '../shared/types'
import { SshManager } from './ssh-manager'
import { TmuxService } from './tmux-service'
import { UploadService } from './upload-service'
import { CodexService } from './codex-service'
import { FileManagerService } from './file-manager-service'
import { friendlyErrorNotice } from './friendly-error'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'muxboard.ico')
    : path.join(__dirname, '../../assets/muxboard.ico')

const profileIdSchema = z.string().uuid()
const textSchema = z.string().trim().min(1).max(200)
const remotePathSchema = z.string().trim().max(4096).optional()
const profileInputSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(128),
    authenticationType: z.enum(['password', 'privateKey', 'agent']),
    privateKeyPath: z.string().max(4096).optional(),
    agentSocket: z.string().max(4096).optional(),
    rememberSecret: z.boolean(),
    secret: z.string().max(16_384).optional(),
    activeCodexProfileId: z.string().uuid().optional(),
    codexProfiles: z.array(z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        baseUrl: z.string().trim().url().max(2048),
        model: z.string().trim().min(1).max(200),
        apiKey: z.string().max(16_384).optional()
    })).max(30).optional()
})

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let rendererReady = false
let lastErrorNotice = { message: '', time: 0 }
let startupWorkspace: WorkspaceState | undefined

function reportUnexpectedMainError(error: unknown): void {
    // Keep technical details in the application log, never in the user-facing UI.
    console.error('[Muxboard main process]', error)
    if (isQuitting) return

    const notice = friendlyErrorNotice(error)
    const now = Date.now()
    if (lastErrorNotice.message === notice.zh && now - lastErrorNotice.time < 4_000) return
    lastErrorNotice = { message: notice.zh, time: now }

    if (rendererReady && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:error', notice)
        return
    }
    dialog.showErrorBox('Muxboard', notice.zh)
}

// Electron otherwise displays an uncaught exception with a stack trace and local
// installation paths. These handlers keep that diagnostic private and show a
// concise, actionable message instead.
process.on('uncaughtException', reportUnexpectedMainError)
process.on('unhandledRejection', reportUnexpectedMainError)

const profiles = new ProfileStore()
const ssh = new SshManager(profiles)
const tmux = new TmuxService(ssh, () => mainWindow?.webContents)
const uploads = new UploadService(ssh)
const codex = new CodexService(ssh, profiles)
const files = new FileManagerService(ssh, () => mainWindow?.webContents)
let windowBackground = '#10110f'

function applyNativeTheme(theme: AppTheme): void {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'
    windowBackground = theme === 'light' ? '#f6f5f1' : theme === 'gray' ? '#1b1d20' : '#10110f'
}

async function quitApplication(): Promise<void> {
    if (isQuitting) return
    isQuitting = true
    tmux.closeAll()
    files.cancelAll()
    await ssh.disconnectAll()
    app.exit(0)
}

function registerIpc(): void {
    ipcMain.handle('settings:terminal-font-size', () => profiles.terminalFontSize())
    ipcMain.handle('settings:set-terminal-font-size', (_event, rawFontSize) => profiles.setTerminalFontSize(z.number().int().min(10).max(24).parse(rawFontSize)))
    ipcMain.handle('settings:background-terminal-sleep-minutes', () => profiles.backgroundTerminalSleepMinutes())
    ipcMain.handle('settings:set-background-terminal-sleep-minutes', async (_event, rawMinutes) => {
        const minutes = z.union([z.literal(0), z.literal(5), z.literal(30), z.literal(60)]).parse(rawMinutes)
        const saved = await profiles.setBackgroundTerminalSleepMinutes(minutes)
        tmux.setBackgroundTerminalSleepMinutes(saved)
        return saved
    })
    ipcMain.handle('settings:theme', () => profiles.theme())
    ipcMain.handle('settings:set-theme', async (_event, rawTheme) => {
        const theme = z.enum(['black', 'gray', 'light']).parse(rawTheme)
        const savedTheme = await profiles.setTheme(theme)
        applyNativeTheme(savedTheme)
        return savedTheme
    })
    ipcMain.handle('settings:language', () => profiles.language())
    ipcMain.handle('settings:set-language', (_event, rawLanguage) => profiles.setLanguage(z.enum(['en', 'zh']).parse(rawLanguage)))
    ipcMain.handle('settings:workspace', () => profiles.workspace())
    ipcMain.handle('settings:set-workspace', async (_event, rawWorkspace) => {
        const workspace = z.object({
            restoreOnLaunch: z.boolean(),
            sidebarOpen: z.boolean().default(true),
            tmuxTreeOpen: z.boolean().default(true),
            sessions: z.array(z.object({ profileId: z.string().uuid(), sessionName: z.string().trim().min(1).max(200), pinned: z.boolean() })).max(100),
            activeSessionKey: z.string().max(500).optional()
        }).parse(rawWorkspace)
        startupWorkspace = await profiles.setWorkspace(workspace)
        return startupWorkspace
    })
    ipcMain.handle('profiles:list', () => profiles.list())
    ipcMain.handle('profiles:save', (_event, input) => profiles.save(profileInputSchema.parse(input)))
    ipcMain.handle('profiles:remove', async (_event, rawProfileId) => {
        const profileId = profileIdSchema.parse(rawProfileId)
        files.cancelForProfile(profileId)
        tmux.closeForProfile(profileId)
        await ssh.disconnect(profileId)
        await profiles.remove(profileId)
    })
    ipcMain.handle('profiles:reveal-private-key', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'], title: '选择 SSH 私钥' })
        return result.canceled ? null : result.filePaths[0] ?? null
    })

    ipcMain.handle('ssh:connect', (_event, rawProfileId, rawSecret) => {
        const profileId = profileIdSchema.parse(rawProfileId)
        const secret = z.string().max(16_384).optional().parse(rawSecret)
        return ssh.connect(profileId, secret)
    })
    ipcMain.handle('ssh:trust-host', (_event, rawProfileId, rawFingerprint) => {
        return ssh.trustHost(profileIdSchema.parse(rawProfileId), z.string().min(10).max(200).parse(rawFingerprint))
    })
    ipcMain.handle('ssh:disconnect', async (_event, rawProfileId) => {
        const profileId = profileIdSchema.parse(rawProfileId)
        files.cancelForProfile(profileId)
        tmux.closeForProfile(profileId)
        await ssh.disconnect(profileId)
    })
    ipcMain.handle('ssh:status', () => ssh.status())
    ipcMain.handle('codex:apply', (_event, rawProfileId, rawCodexProfileId) => codex.apply(profileIdSchema.parse(rawProfileId), profileIdSchema.parse(rawCodexProfileId)))

    ipcMain.handle('tmux:snapshot', (_event, profileId) => tmux.snapshot(profileIdSchema.parse(profileId)))
    ipcMain.handle('tmux:create-session', (_event, profileId, name, cwd) => tmux.createSession(profileIdSchema.parse(profileId), textSchema.parse(name), remotePathSchema.parse(cwd)))
    ipcMain.handle('tmux:rename-session', (_event, profileId, sessionName, nextName) => tmux.renameSession(profileIdSchema.parse(profileId), textSchema.parse(sessionName), textSchema.parse(nextName)))
    ipcMain.handle('tmux:kill-session', (_event, profileId, sessionName) => tmux.killSession(profileIdSchema.parse(profileId), textSchema.parse(sessionName)))
    ipcMain.handle('tmux:create-window', (_event, profileId, sessionName, name, cwd) => tmux.createWindow(profileIdSchema.parse(profileId), textSchema.parse(sessionName), textSchema.parse(name), remotePathSchema.parse(cwd)))
    ipcMain.handle('tmux:rename-window', (_event, profileId, windowId, name) => tmux.renameWindow(profileIdSchema.parse(profileId), textSchema.parse(windowId), textSchema.parse(name)))
    ipcMain.handle('tmux:kill-window', (_event, profileId, windowId) => tmux.killWindow(profileIdSchema.parse(profileId), textSchema.parse(windowId)))
    ipcMain.handle('tmux:split-pane', (_event, profileId, paneId, direction, cwd) => tmux.splitPane(profileIdSchema.parse(profileId), textSchema.parse(paneId), z.enum(['horizontal', 'vertical']).parse(direction), remotePathSchema.parse(cwd)))
    ipcMain.handle('tmux:kill-pane', (_event, profileId, paneId) => tmux.killPane(profileIdSchema.parse(profileId), textSchema.parse(paneId)))
    ipcMain.handle('tmux:select-window', (_event, profileId, windowId) => tmux.selectWindow(profileIdSchema.parse(profileId), textSchema.parse(windowId)))
    ipcMain.handle('tmux:select-pane', (_event, profileId, paneId) => tmux.selectPane(profileIdSchema.parse(profileId), textSchema.parse(paneId)))

    ipcMain.handle('terminal:attach', async (_event, rawProfileId, rawSessionName, rawCols, rawRows) => {
        const profileId = profileIdSchema.parse(rawProfileId)
        const profile = await profiles.get(profileId)
        return tmux.attach(profileId, profile.name, textSchema.parse(rawSessionName), z.number().int().min(20).max(1000).parse(rawCols), z.number().int().min(5).max(500).parse(rawRows))
    })
    ipcMain.handle('terminal:input', (_event, terminalId, data) => tmux.input(z.string().uuid().parse(terminalId), z.string().max(1_000_000).parse(data)))
    ipcMain.handle('terminal:resize', (_event, terminalId, cols, rows) => tmux.resize(z.string().uuid().parse(terminalId), z.number().int().min(20).max(1000).parse(cols), z.number().int().min(5).max(500).parse(rows)))
    ipcMain.handle('terminal:set-active', (_event, terminalId) => tmux.setActive(z.string().uuid().optional().parse(terminalId)))
    ipcMain.handle('terminal:sleep-background', () => tmux.sleepBackgroundTerminals())
    ipcMain.handle('terminal:close', (_event, terminalId) => tmux.close(z.string().uuid().parse(terminalId)))

    ipcMain.handle('upload:clipboard-image', (_event, profileId) => uploads.clipboardImage(profileIdSchema.parse(profileId)))
    ipcMain.handle('upload:choose-file', (_event, profileId, destinationDirectory) => uploads.chooseFile(profileIdSchema.parse(profileId), remotePathSchema.parse(destinationDirectory)))
    ipcMain.handle('files:initial-paths', (_event, rawProfileId, rawPreferredRemotePath) => files.initialPaths(
        profileIdSchema.parse(rawProfileId),
        remotePathSchema.parse(rawPreferredRemotePath)
    ))
    ipcMain.handle('files:list-local', (_event, rawPath) => files.listLocal(z.string().trim().min(1).max(32_768).parse(rawPath)))
    ipcMain.handle('files:list-remote', (_event, rawProfileId, rawPath) => files.listRemote(
        profileIdSchema.parse(rawProfileId),
        z.string().trim().min(1).max(4096).parse(rawPath)
    ))
    ipcMain.handle('files:choose-local-directory', () => files.chooseLocalDirectory())
    ipcMain.handle('files:start-transfer', (_event, rawInput) => files.startTransfer(z.object({
        profileId: profileIdSchema,
        direction: z.enum(['upload', 'download']),
        sourcePath: z.string().trim().min(1).max(32_768),
        destinationDirectory: z.string().trim().min(1).max(32_768),
        overwrite: z.boolean().optional()
    }).parse(rawInput)))
    ipcMain.handle('files:cancel-transfer', (_event, rawTransferId) => files.cancelTransfer(z.string().uuid().parse(rawTransferId)))
    ipcMain.handle('clipboard:read-text', () => clipboard.readText())
    ipcMain.handle('clipboard:write-text', (_event, text) => clipboard.writeText(z.string().max(1_000_000).parse(text)))
}

function createWindow(): void {
    rendererReady = false
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 920,
        minWidth: 980,
        minHeight: 640,
        backgroundColor: windowBackground,
        title: 'Muxboard',
        icon: appIconPath,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            additionalArguments: [
                `--muxboard-sidebar-open=${startupWorkspace?.sidebarOpen === false ? '0' : '1'}`,
                `--muxboard-tmux-tree-open=${startupWorkspace?.tmuxTreeOpen === false ? '0' : '1'}`
            ]
        }
    })
    mainWindow.once('ready-to-show', () => mainWindow?.show())
    mainWindow.webContents.once('did-finish-load', () => { rendererReady = true })
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.alt || input.control || input.meta || input.shift || input.key.toLowerCase() !== 'v') return
        event.preventDefault()
        mainWindow?.webContents.send('shortcut:clipboard-image')
    })
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
    })
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) void mainWindow.loadURL(devUrl)
    else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    mainWindow.on('close', (event) => {
        if (isQuitting) return
        event.preventDefault()
        void quitApplication()
    })
    mainWindow.on('closed', () => {
        rendererReady = false
        mainWindow = null
    })
}

app.whenReady().then(async () => {
    applyNativeTheme(await profiles.theme())
    tmux.setBackgroundTerminalSleepMinutes(await profiles.backgroundTerminalSleepMinutes())
    startupWorkspace = await profiles.workspace()
    registerIpc()
    createWindow()
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
    tmux.closeAll()
    files.cancelAll()
    void ssh.disconnectAll()
})
