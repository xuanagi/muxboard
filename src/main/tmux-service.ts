import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { ClientChannel } from 'ssh2'
import { parseTmuxRows, shellQuote, tmuxInventoryFormat } from '../shared/tmux'
import type { BackgroundTerminalSleepMinutes, TerminalTab, TmuxSnapshot } from '../shared/types'
import type { SshManager } from './ssh-manager'

type TerminalHandle = {
    channel?: ClientChannel
    profileId: string
    sessionKey: string
    serverName: string
    sessionName: string
    cols: number
    rows: number
    pendingData: string
    pendingInput: string
    flushTimer?: ReturnType<typeof setTimeout>
    sleepTimer?: ReturnType<typeof setTimeout>
    backgroundSince?: number
    waking?: Promise<void>
    sleeping?: boolean
}

const TERMINAL_BATCH_MS = 8
const TERMINAL_BATCH_MAX_CHARS = 64 * 1024
const TMUX_QUERY_TIMEOUT_MS = 10_000
const TMUX_MUTATION_TIMEOUT_MS = 20_000
const DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES: BackgroundTerminalSleepMinutes = 30
const MAX_PENDING_TERMINAL_INPUT = 1_000_000

export class TmuxService {
    private readonly terminals = new Map<string, TerminalHandle>()
    private readonly sessionTabs = new Map<string, TerminalTab>()
    private readonly attachingSessions = new Map<string, Promise<TerminalTab>>()
    private readonly monitoredProfiles = new Set<string>()
    private readonly tmuxVersions = new Map<string, string>()
    private activeTerminalId?: string
    private backgroundTerminalSleepMinutes: BackgroundTerminalSleepMinutes = DEFAULT_BACKGROUND_TERMINAL_SLEEP_MINUTES

    constructor(private readonly ssh: SshManager, private readonly webContents: () => WebContents | undefined) {}

    async snapshot(profileId: string): Promise<TmuxSnapshot> {
        let tmuxVersion = this.tmuxVersions.get(profileId)
        if (!tmuxVersion) {
            const versionResult = await this.ssh.execPersistent(profileId, 'tmux -V', { timeoutMs: TMUX_QUERY_TIMEOUT_MS, retry: true })
            if (versionResult.code !== 0) throw new Error(versionResult.stderr || '远端未安装 tmux')
            tmuxVersion = versionResult.stdout.trim()
            this.tmuxVersions.set(profileId, tmuxVersion)
        }
        const command = `tmux list-panes -a -F ${shellQuote(tmuxInventoryFormat())}`
        const result = await this.ssh.execPersistent(profileId, command, { timeoutMs: TMUX_QUERY_TIMEOUT_MS, retry: true })
        if (result.code !== 0) {
            if (/no server running|no sessions/u.test(result.stderr)) {
                return { sessions: [], tmuxVersion, capturedAt: Date.now() }
            }
            throw new Error(result.stderr || '无法读取 tmux 会话')
        }
        const snapshot = parseTmuxRows(result.stdout, tmuxVersion)
        // tmux only sets the alert flags when these window options are enabled.
        // Enable them once for each connected profile; this never changes pane contents.
        if (!this.monitoredProfiles.has(profileId)) {
            this.monitoredProfiles.add(profileId)
            const monitorCommands = snapshot.sessions.flatMap((session) => session.windows.flatMap((windowItem) => [
                `tmux set-window-option -t ${shellQuote(windowItem.id)} monitor-activity on`,
                `tmux set-window-option -t ${shellQuote(windowItem.id)} monitor-bell on`
            ]))
            if (monitorCommands.length > 0) await this.ssh.exec(profileId, monitorCommands.join(' && '), { timeoutMs: TMUX_MUTATION_TIMEOUT_MS, retry: true }).catch(() => undefined)
        }
        return snapshot
    }

    async createSession(profileId: string, name: string, cwd?: string): Promise<void> {
        await this.run(profileId, `tmux new-session -d -s ${shellQuote(name)}${cwd ? ` -c ${shellQuote(cwd)}` : ''}`)
    }

    async renameSession(profileId: string, sessionName: string, nextName: string): Promise<void> {
        await this.run(profileId, `tmux rename-session -t ${shellQuote(sessionName)} ${shellQuote(nextName)}`)
    }

    async killSession(profileId: string, sessionName: string): Promise<void> {
        await this.run(profileId, `tmux kill-session -t ${shellQuote(sessionName)}`)
    }

    async createWindow(profileId: string, sessionName: string, name: string, cwd?: string): Promise<void> {
        await this.run(profileId, `tmux new-window -d -t ${shellQuote(`${sessionName}:`)} -n ${shellQuote(name)}${cwd ? ` -c ${shellQuote(cwd)}` : ''}`)
    }

    async renameWindow(profileId: string, windowId: string, name: string): Promise<void> {
        await this.run(profileId, `tmux rename-window -t ${shellQuote(windowId)} ${shellQuote(name)}`)
    }

    async killWindow(profileId: string, windowId: string): Promise<void> {
        await this.run(profileId, `tmux kill-window -t ${shellQuote(windowId)}`)
    }

    async splitPane(profileId: string, paneId: string, direction: 'horizontal' | 'vertical', cwd?: string): Promise<void> {
        const flag = direction === 'horizontal' ? '-h' : '-v'
        await this.run(profileId, `tmux split-window ${flag} -d -t ${shellQuote(paneId)}${cwd ? ` -c ${shellQuote(cwd)}` : ''}`)
    }

    async killPane(profileId: string, paneId: string): Promise<void> {
        await this.run(profileId, `tmux kill-pane -t ${shellQuote(paneId)}`)
    }

    async selectPane(profileId: string, paneId: string): Promise<void> {
        await this.run(profileId, `tmux select-pane -t ${shellQuote(paneId)}`)
    }

    async selectWindow(profileId: string, windowId: string): Promise<void> {
        await this.run(profileId, `tmux select-window -t ${shellQuote(windowId)}`)
    }

    async attach(profileId: string, serverName: string, sessionName: string, cols: number, rows: number): Promise<TerminalTab> {
        const sessionKey = `${profileId}\u0000${sessionName}`
        const existing = this.sessionTabs.get(sessionKey)
        if (existing) {
            const terminal = this.terminals.get(existing.id)
            if (terminal) {
                await this.wakeTerminal(existing.id, terminal)
                if (this.activeTerminalId !== existing.id) this.scheduleTerminalSleep(existing.id, terminal)
                return existing
            }
        }

        const attaching = this.attachingSessions.get(sessionKey)
        if (attaching) return await attaching

        const opening = this.openTerminal(profileId, serverName, sessionName, sessionKey, cols, rows)
        this.attachingSessions.set(sessionKey, opening)
        try {
            return await opening
        } finally {
            if (this.attachingSessions.get(sessionKey) === opening) this.attachingSessions.delete(sessionKey)
        }
    }

    private async openTerminal(profileId: string, serverName: string, sessionName: string, sessionKey: string, cols: number, rows: number): Promise<TerminalTab> {
        const id = randomUUID()
        const channel = await this.ssh.terminal(profileId, `tmux attach-session -t ${shellQuote(sessionName)}`, cols, rows)
        const tab = { id, profileId, serverName, sessionName, title: `${serverName} / ${sessionName}` }
        const terminal: TerminalHandle = {
            channel, profileId, sessionKey, serverName, sessionName, cols, rows,
            pendingData: '', pendingInput: ''
        }
        this.terminals.set(id, terminal)
        this.sessionTabs.set(sessionKey, tab)
        this.bindTerminalChannel(id, terminal, channel)
        this.scheduleTerminalSleep(id, terminal)
        return tab
    }

    private bindTerminalChannel(terminalId: string, terminal: TerminalHandle, channel: ClientChannel): void {
        terminal.channel = channel
        terminal.sleeping = false
        channel.setEncoding('utf8')
        channel.stderr.setEncoding('utf8')
        channel.on('data', (data: Buffer | string) => {
            if (terminal.channel === channel) this.queueTerminalData(terminalId, terminal, data.toString())
        })
        channel.stderr.on('data', (data: Buffer | string) => {
            if (terminal.channel === channel) this.queueTerminalData(terminalId, terminal, data.toString())
        })
        channel.on('close', (code: number | null, signal?: string) => {
            if (terminal.channel !== channel) return
            terminal.channel = undefined
            if (terminal.sleeping) return
            this.flushTerminalData(terminalId, terminal)
            this.terminals.delete(terminalId)
            if (this.sessionTabs.get(terminal.sessionKey)?.id === terminalId) this.sessionTabs.delete(terminal.sessionKey)
            this.webContents()?.send('terminal:exit', { terminalId, code, signal })
        })
    }

    private queueTerminalData(terminalId: string, terminal: TerminalHandle, data: string): void {
        if (!data || this.terminals.get(terminalId) !== terminal) return
        terminal.pendingData += data
        if (terminal.pendingData.length >= TERMINAL_BATCH_MAX_CHARS) {
            this.flushTerminalData(terminalId, terminal)
            return
        }
        terminal.flushTimer ??= setTimeout(() => this.flushTerminalData(terminalId, terminal), TERMINAL_BATCH_MS)
    }

    private flushTerminalData(terminalId: string, terminal: TerminalHandle): void {
        if (terminal.flushTimer) clearTimeout(terminal.flushTimer)
        terminal.flushTimer = undefined
        if (!terminal.pendingData) return
        const data = terminal.pendingData
        terminal.pendingData = ''
        this.webContents()?.send('terminal:data', { terminalId, data })
    }

    async setActive(terminalId?: string): Promise<void> {
        const previousId = this.activeTerminalId
        this.activeTerminalId = terminalId
        if (previousId && previousId !== terminalId) {
            const previous = this.terminals.get(previousId)
            if (previous) {
                previous.backgroundSince = Date.now()
                this.scheduleTerminalSleep(previousId, previous)
            }
        }
        if (!terminalId) return
        const terminal = this.terminals.get(terminalId)
        if (!terminal) return
        if (terminal.sleepTimer) clearTimeout(terminal.sleepTimer)
        terminal.sleepTimer = undefined
        terminal.backgroundSince = undefined
        await this.wakeTerminal(terminalId, terminal)
    }

    setBackgroundTerminalSleepMinutes(minutes: BackgroundTerminalSleepMinutes): void {
        this.backgroundTerminalSleepMinutes = minutes
        for (const [terminalId, terminal] of this.terminals) {
            if (terminal.sleepTimer) clearTimeout(terminal.sleepTimer)
            terminal.sleepTimer = undefined
            if (this.activeTerminalId === terminalId) continue
            terminal.backgroundSince ??= Date.now()
            this.scheduleTerminalSleep(terminalId, terminal)
        }
    }

    sleepBackgroundTerminals(): number {
        let sleepingCount = 0
        for (const [terminalId, terminal] of this.terminals) {
            if (terminalId === this.activeTerminalId || !terminal.channel) continue
            if (terminal.sleepTimer) clearTimeout(terminal.sleepTimer)
            terminal.sleepTimer = undefined
            this.sleepTerminal(terminalId, terminal)
            sleepingCount += 1
        }
        return sleepingCount
    }

    private scheduleTerminalSleep(terminalId: string, terminal: TerminalHandle): void {
        if (terminal.sleepTimer) clearTimeout(terminal.sleepTimer)
        if (this.backgroundTerminalSleepMinutes === 0) return
        terminal.backgroundSince ??= Date.now()
        const elapsedMs = Date.now() - terminal.backgroundSince
        const delayMs = Math.max(0, this.backgroundTerminalSleepMinutes * 60_000 - elapsedMs)
        terminal.sleepTimer = setTimeout(() => {
            terminal.sleepTimer = undefined
            if (this.activeTerminalId === terminalId || this.terminals.get(terminalId) !== terminal) return
            this.sleepTerminal(terminalId, terminal)
        }, delayMs)
    }

    private sleepTerminal(terminalId: string, terminal: TerminalHandle): void {
        if (this.activeTerminalId === terminalId || !terminal.channel) return
        this.flushTerminalData(terminalId, terminal)
        const channel = terminal.channel
        terminal.sleeping = true
        terminal.channel = undefined
        channel.destroy()
    }

    private async wakeTerminal(terminalId: string, terminal: TerminalHandle): Promise<void> {
        if (terminal.channel) return
        if (terminal.waking) return await terminal.waking
        const waking = (async () => {
            const channel = await this.ssh.terminal(
                terminal.profileId,
                `tmux attach-session -t ${shellQuote(terminal.sessionName)}`,
                terminal.cols,
                terminal.rows
            )
            if (this.terminals.get(terminalId) !== terminal) {
                channel.destroy()
                return
            }
            this.webContents()?.send('terminal:data', { terminalId, data: '\x1b[2J\x1b[H' })
            this.bindTerminalChannel(terminalId, terminal, channel)
            if (terminal.pendingInput) {
                const input = terminal.pendingInput
                terminal.pendingInput = ''
                channel.write(input)
            }
        })()
        terminal.waking = waking
        try {
            await waking
        } finally {
            if (terminal.waking === waking) terminal.waking = undefined
        }
    }

    input(terminalId: string, data: string): void {
        const terminal = this.terminals.get(terminalId)
        if (!terminal) throw new Error('终端已关闭')
        if (terminal.channel) {
            terminal.channel.write(data)
            return
        }
        terminal.pendingInput = `${terminal.pendingInput}${data}`.slice(-MAX_PENDING_TERMINAL_INPUT)
        if (this.activeTerminalId === terminalId) void this.wakeTerminal(terminalId, terminal).catch(() => undefined)
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const terminal = this.terminals.get(terminalId)
        if (!terminal) return
        terminal.cols = cols
        terminal.rows = rows
        terminal.channel?.setWindow(rows, cols, 0, 0)
    }

    close(terminalId: string): void {
        const terminal = this.terminals.get(terminalId)
        if (terminal) this.flushTerminalData(terminalId, terminal)
        if (terminal?.sleepTimer) clearTimeout(terminal.sleepTimer)
        terminal?.channel?.destroy()
        this.terminals.delete(terminalId)
        if (this.activeTerminalId === terminalId) this.activeTerminalId = undefined
        if (terminal && this.sessionTabs.get(terminal.sessionKey)?.id === terminalId) this.sessionTabs.delete(terminal.sessionKey)
    }

    closeForProfile(profileId: string): void {
        this.monitoredProfiles.delete(profileId)
        this.tmuxVersions.delete(profileId)
        for (const [id, terminal] of this.terminals) {
            if (terminal.profileId === profileId) this.close(id)
        }
    }

    closeAll(): void {
        for (const id of [...this.terminals.keys()]) this.close(id)
        this.activeTerminalId = undefined
        this.monitoredProfiles.clear()
        this.tmuxVersions.clear()
    }

    private async run(profileId: string, command: string): Promise<void> {
        const result = await this.ssh.exec(profileId, command, { timeoutMs: TMUX_MUTATION_TIMEOUT_MS })
        if (result.code !== 0) throw new Error(result.stderr || `命令执行失败：${command}`)
    }
}
