import { contextBridge, ipcRenderer } from 'electron'
import type { AppErrorNotice, FileTransferEvent, MuxboardDesktopApi, TerminalDataEvent, TerminalExitEvent } from '../shared/types'

const initialLayout = {
    sidebarOpen: !process.argv.includes('--muxboard-sidebar-open=0'),
    tmuxTreeOpen: !process.argv.includes('--muxboard-tmux-tree-open=0')
}

const api: MuxboardDesktopApi = {
    errors: {
        onError: (callback) => {
            const listener = (_event: Electron.IpcRendererEvent, notice: AppErrorNotice): void => callback(notice)
            ipcRenderer.on('app:error', listener)
            return () => ipcRenderer.removeListener('app:error', listener)
        }
    },
    settings: {
        initialLayout: () => initialLayout,
        terminalFontSize: () => ipcRenderer.invoke('settings:terminal-font-size'),
        setTerminalFontSize: (fontSize) => ipcRenderer.invoke('settings:set-terminal-font-size', fontSize),
        backgroundTerminalSleepMinutes: () => ipcRenderer.invoke('settings:background-terminal-sleep-minutes'),
        setBackgroundTerminalSleepMinutes: (minutes) => ipcRenderer.invoke('settings:set-background-terminal-sleep-minutes', minutes),
        theme: () => ipcRenderer.invoke('settings:theme'),
        setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
        language: () => ipcRenderer.invoke('settings:language'),
        setLanguage: (language) => ipcRenderer.invoke('settings:set-language', language),
        workspace: () => ipcRenderer.invoke('settings:workspace'),
        setWorkspace: (workspace) => ipcRenderer.invoke('settings:set-workspace', workspace)
    },
    profiles: {
        list: () => ipcRenderer.invoke('profiles:list'),
        save: (input) => ipcRenderer.invoke('profiles:save', input),
        remove: (profileId) => ipcRenderer.invoke('profiles:remove', profileId),
        revealPrivateKey: () => ipcRenderer.invoke('profiles:reveal-private-key')
    },
    ssh: {
        connect: (profileId, secret) => ipcRenderer.invoke('ssh:connect', profileId, secret),
        trustHost: (profileId, fingerprint) => ipcRenderer.invoke('ssh:trust-host', profileId, fingerprint),
        disconnect: (profileId) => ipcRenderer.invoke('ssh:disconnect', profileId),
        status: () => ipcRenderer.invoke('ssh:status')
    },
    codex: {
        apply: (profileId, codexProfileId) => ipcRenderer.invoke('codex:apply', profileId, codexProfileId)
    },
    tmux: {
        snapshot: (profileId) => ipcRenderer.invoke('tmux:snapshot', profileId),
        createSession: (profileId, name, cwd) => ipcRenderer.invoke('tmux:create-session', profileId, name, cwd),
        renameSession: (profileId, sessionName, nextName) => ipcRenderer.invoke('tmux:rename-session', profileId, sessionName, nextName),
        killSession: (profileId, sessionName) => ipcRenderer.invoke('tmux:kill-session', profileId, sessionName),
        createWindow: (profileId, sessionName, name, cwd) => ipcRenderer.invoke('tmux:create-window', profileId, sessionName, name, cwd),
        renameWindow: (profileId, windowId, name) => ipcRenderer.invoke('tmux:rename-window', profileId, windowId, name),
        killWindow: (profileId, windowId) => ipcRenderer.invoke('tmux:kill-window', profileId, windowId),
        splitPane: (profileId, paneId, direction, cwd) => ipcRenderer.invoke('tmux:split-pane', profileId, paneId, direction, cwd),
        killPane: (profileId, paneId) => ipcRenderer.invoke('tmux:kill-pane', profileId, paneId),
        selectPane: (profileId, paneId) => ipcRenderer.invoke('tmux:select-pane', profileId, paneId),
        selectWindow: (profileId, windowId) => ipcRenderer.invoke('tmux:select-window', profileId, windowId)
    },
    terminal: {
        attach: (profileId, sessionName, cols, rows) => ipcRenderer.invoke('terminal:attach', profileId, sessionName, cols, rows),
        input: (terminalId, data) => ipcRenderer.invoke('terminal:input', terminalId, data),
        resize: (terminalId, cols, rows) => ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),
        setActive: (terminalId) => ipcRenderer.invoke('terminal:set-active', terminalId),
        sleepBackground: () => ipcRenderer.invoke('terminal:sleep-background'),
        close: (terminalId) => ipcRenderer.invoke('terminal:close', terminalId),
        onData: (callback) => {
            const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => callback(payload)
            ipcRenderer.on('terminal:data', listener)
            return () => ipcRenderer.removeListener('terminal:data', listener)
        },
        onExit: (callback) => {
            const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void => callback(payload)
            ipcRenderer.on('terminal:exit', listener)
            return () => ipcRenderer.removeListener('terminal:exit', listener)
        }
    },
    upload: {
        clipboardImage: (profileId) => ipcRenderer.invoke('upload:clipboard-image', profileId),
        chooseFile: (profileId, destinationDirectory) => ipcRenderer.invoke('upload:choose-file', profileId, destinationDirectory)
    },
    files: {
        initialPaths: (profileId, preferredRemotePath) => ipcRenderer.invoke('files:initial-paths', profileId, preferredRemotePath),
        listLocal: (path) => ipcRenderer.invoke('files:list-local', path),
        listRemote: (profileId, path) => ipcRenderer.invoke('files:list-remote', profileId, path),
        chooseLocalDirectory: () => ipcRenderer.invoke('files:choose-local-directory'),
        startTransfer: (input) => ipcRenderer.invoke('files:start-transfer', input),
        cancelTransfer: (transferId) => ipcRenderer.invoke('files:cancel-transfer', transferId),
        onTransfer: (callback) => {
            const listener = (_event: Electron.IpcRendererEvent, payload: FileTransferEvent): void => callback(payload)
            ipcRenderer.on('files:transfer', listener)
            return () => ipcRenderer.removeListener('files:transfer', listener)
        }
    },
    shortcuts: {
        onClipboardImage: (callback) => {
            const listener = (): void => callback()
            ipcRenderer.on('shortcut:clipboard-image', listener)
            return () => ipcRenderer.removeListener('shortcut:clipboard-image', listener)
        }
    },
    clipboard: {
        text: () => ipcRenderer.invoke('clipboard:read-text'),
        writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text)
    }
}

contextBridge.exposeInMainWorld('muxboard', api)
