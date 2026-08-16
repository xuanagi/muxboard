import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Client, type ClientChannel, type CompressionAlgorithm, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { ConnectResult, ServerConnection } from '../shared/types'
import { friendlySshErrorMessage } from './friendly-error'
import type { ProfileStore } from './profile-store'

type ActiveConnection = {
    client: Client
    managementClient?: Client
    managementReady?: Promise<Client>
    fileClient?: Client
    fileReady?: Promise<Client>
    commandShell?: PersistentCommandShell
    commandQueue?: Promise<void>
    config?: ConnectConfig
    status: ServerConnection
    home?: string
}

type PersistentCommandResult = { stdout: string; stderr: string; code: number | null }

type PersistentCommandShell = {
    channel: ClientChannel
    buffer: string
    pending?: {
        marker: string
        timer: ReturnType<typeof setTimeout>
        resolve: (result: PersistentCommandResult) => void
        reject: (error: Error) => void
    }
}

export type SshExecOptions = {
    timeoutMs?: number
    retry?: boolean
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const PERSISTENT_SHELL_OPEN_TIMEOUT_MS = 10_000
const SFTP_OPEN_TIMEOUT_MS = 15_000
const TERMINAL_COMPRESSION: CompressionAlgorithm[] = ['zlib@openssh.com', 'zlib', 'none']

function fingerprint(key: Buffer): string {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

export class SshManager {
    private readonly connections = new Map<string, ActiveConnection>()
    private readonly pendingFingerprints = new Map<string, string>()

    constructor(private readonly profiles: ProfileStore) {}

    async connect(profileId: string, suppliedSecret?: string): Promise<ConnectResult> {
        const existing = this.connections.get(profileId)
        if (existing?.status.status === 'connected') {
            const profile = await this.profiles.get(profileId)
            return { ok: true, fingerprint: profile.hostFingerprint ?? '' }
        }
        if (existing) {
            this.resetManagementClient(profileId)
            this.resetFileClient(profileId)
            existing.client.end()
        }

        const profile = await this.profiles.get(profileId)
        const secret = suppliedSecret || await this.profiles.secret(profileId)
        let observedFingerprint = ''
        let unknownHost = false
        const client = new Client()
        const status: ServerConnection = { profileId, status: 'connecting' }
        const connection: ActiveConnection = { client, status }
        this.connections.set(profileId, connection)

        const config: ConnectConfig = {
            host: profile.host,
            port: profile.port,
            username: profile.username,
            readyTimeout: 15_000,
            keepaliveInterval: 10_000,
            keepaliveCountMax: 3,
            hostVerifier: (key: Buffer) => {
                observedFingerprint = fingerprint(key)
                if (!profile.hostFingerprint || profile.hostFingerprint !== observedFingerprint) {
                    unknownHost = true
                    this.pendingFingerprints.set(profileId, observedFingerprint)
                    return false
                }
                return true
            }
        }

        if (profile.authenticationType === 'password') {
            if (!secret) return this.fail(profileId, client, '需要输入 SSH 密码')
            config.password = secret
            config.tryKeyboard = true
            client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
                finish(prompts.map(() => secret))
            })
        } else if (profile.authenticationType === 'privateKey') {
            if (!profile.privateKeyPath) return this.fail(profileId, client, '未设置私钥路径')
            try {
                const privateKeyPath = profile.privateKeyPath.startsWith('~/')
                    ? path.join(homedir(), profile.privateKeyPath.slice(2))
                    : profile.privateKeyPath
                config.privateKey = await readFile(privateKeyPath)
                if (secret) config.passphrase = secret
            } catch (error) {
                return this.fail(profileId, client, `无法读取私钥：${this.message(error)}`)
            }
        } else {
            const agent = profile.agentSocket || process.env.SSH_AUTH_SOCK
            if (!agent) return this.fail(profileId, client, '未找到 SSH Agent，请设置套接字路径')
            config.agent = agent
        }
        connection.config = config

        return await new Promise<ConnectResult>((resolve) => {
            let settled = false
            const settle = (result: ConnectResult): void => {
                if (settled) return
                settled = true
                resolve(result)
            }
            client.once('ready', () => {
                client.setNoDelay(true)
                status.status = 'connected'
                status.connectedAt = Date.now()
                status.message = undefined
                this.pendingFingerprints.delete(profileId)
                settle({ ok: true, fingerprint: observedFingerprint || profile.hostFingerprint || '' })
            })
            client.on('error', (error) => {
                // ssh2 may emit another error after an initial connection error.
                // Keep this listener for the full client lifetime so Electron never
                // treats a transient network failure as an uncaught exception.
                if (this.connections.get(profileId) !== connection) return
                this.resetManagementClient(profileId)
                this.resetFileClient(profileId)
                if (unknownHost && observedFingerprint) {
                    status.status = 'disconnected'
                    status.message = '等待确认服务器指纹'
                    settle({
                        ok: false,
                        code: 'HOST_KEY_UNKNOWN',
                        fingerprint: observedFingerprint,
                        message: profile.hostFingerprint
                            ? '服务器指纹与已保存值不同。请确认服务器是否已重装，谨防中间人攻击。'
                            : '首次连接需要确认服务器指纹。'
                    })
                } else {
                    status.status = 'error'
                    status.message = friendlySshErrorMessage(error)
                    settle({ ok: false, code: 'CONNECTION_FAILED', message: status.message })
                }
            })
            client.on('close', () => {
                if (this.connections.get(profileId) !== connection) return
                this.resetManagementClient(profileId)
                this.resetFileClient(profileId)
                if (status.status === 'connected') {
                    status.status = 'disconnected'
                    status.message = 'SSH 连接已关闭；远端 tmux 任务仍在运行'
                } else if (status.status === 'connecting') {
                    status.status = 'error'
                    status.message = friendlySshErrorMessage('Connection closed before handshake')
                    settle({ ok: false, code: 'CONNECTION_FAILED', message: status.message })
                }
            })
            try {
                client.connect({
                    ...config,
                    algorithms: { ...config.algorithms, compress: TERMINAL_COMPRESSION }
                })
                // Trusted profiles can establish the management transport in
                // parallel with terminal authentication, removing a serial SSH
                // handshake from the first tmux snapshot.
                if (profile.hostFingerprint) void this.managementClient(profileId, true).catch(() => undefined)
            } catch (error) {
                this.resetManagementClient(profileId)
                this.resetFileClient(profileId)
                status.status = 'error'
                status.message = friendlySshErrorMessage(error)
                settle({ ok: false, code: 'CONNECTION_FAILED', message: status.message })
            }
        })
    }

    private fail(profileId: string, client: Client, message: string): ConnectResult {
        this.connections.set(profileId, { client, status: { profileId, status: 'error', message } })
        return { ok: false, code: 'CONNECTION_FAILED', message }
    }

    async trustHost(profileId: string, fingerprintValue: string): Promise<void> {
        const pending = this.pendingFingerprints.get(profileId)
        if (!pending || pending !== fingerprintValue) throw new Error('待确认的服务器指纹已失效，请重新连接')
        await this.profiles.trustHost(profileId, fingerprintValue)
    }

    async disconnect(profileId: string): Promise<void> {
        const connection = this.connections.get(profileId)
        this.resetManagementClient(profileId)
        this.resetFileClient(profileId)
        connection?.client.end()
        this.connections.delete(profileId)
    }

    async disconnectAll(): Promise<void> {
        for (const [profileId, connection] of this.connections) {
            this.resetManagementClient(profileId)
            this.resetFileClient(profileId)
            connection.client.end()
        }
        this.connections.clear()
    }

    status(): ServerConnection[] {
        return [...this.connections.values()].map((item) => ({ ...item.status }))
    }

    client(profileId: string): Client {
        const connection = this.connections.get(profileId)
        if (!connection || connection.status.status !== 'connected') throw new Error('服务器尚未连接')
        return connection.client
    }

    private async managementClient(profileId: string, allowConnecting = false): Promise<Client> {
        const connection = this.connections.get(profileId)
        if (!connection || (!allowConnecting && connection.status.status !== 'connected') || !connection.config) throw new Error('服务器尚未连接')
        if (connection.managementReady) return await connection.managementReady
        if (connection.managementClient) return connection.managementClient

        // Keep background commands off the latency-sensitive terminal TCP stream
        // so packet loss on either connection cannot block both.
        const config = connection.config
        const password = config.password
        const client = new Client()
        connection.managementClient = client
        const opening = new Promise<Client>((resolve, reject) => {
            let ready = false
            if (config.tryKeyboard && typeof password === 'string') {
                client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
                    finish(prompts.map(() => password))
                })
            }
            client.once('ready', () => {
                ready = true
                client.setNoDelay(true)
                resolve(client)
            })
            client.on('error', (error) => {
                reject(error)
                this.resetManagementClient(profileId, client)
            })
            client.once('close', () => {
                if (!ready) reject(new Error('Connection closed before handshake'))
                this.resetManagementClient(profileId, client)
            })
            try {
                client.connect({ ...config })
            } catch (error) {
                if (connection.managementClient === client) connection.managementClient = undefined
                reject(error)
            }
        })
        connection.managementReady = opening
        try {
            return await opening
        } finally {
            if (connection.managementReady === opening) connection.managementReady = undefined
        }
    }

    private resetManagementClient(profileId: string, expectedClient?: Client): void {
        const connection = this.connections.get(profileId)
        if (!connection || (expectedClient && connection.managementClient !== expectedClient)) return
        const client = connection.managementClient
        const shell = connection.commandShell
        connection.managementClient = undefined
        connection.managementReady = undefined
        connection.commandShell = undefined
        if (shell?.pending) {
            clearTimeout(shell.pending.timer)
            shell.pending.reject(new Error('SSH 管理连接已重置'))
            shell.pending = undefined
        }
        shell?.channel.destroy()
        client?.destroy()
    }

    private async fileTransferClient(profileId: string): Promise<Client> {
        const connection = this.connections.get(profileId)
        if (!connection || connection.status.status !== 'connected' || !connection.config) throw new Error('服务器尚未连接')
        if (connection.fileReady) return await connection.fileReady
        if (connection.fileClient) return connection.fileClient

        const config = connection.config
        const password = config.password
        const client = new Client()
        connection.fileClient = client
        const opening = new Promise<Client>((resolve, reject) => {
            let ready = false
            if (config.tryKeyboard && typeof password === 'string') {
                client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
                    finish(prompts.map(() => password))
                })
            }
            client.once('ready', () => {
                ready = true
                client.setNoDelay(true)
                resolve(client)
            })
            client.on('error', (error) => {
                reject(error)
                this.resetFileClient(profileId, client)
            })
            client.once('close', () => {
                if (!ready) reject(new Error('Connection closed before handshake'))
                this.resetFileClient(profileId, client)
            })
            try {
                client.connect({ ...config })
            } catch (error) {
                if (connection.fileClient === client) connection.fileClient = undefined
                reject(error)
            }
        })
        connection.fileReady = opening
        try {
            return await opening
        } finally {
            if (connection.fileReady === opening) connection.fileReady = undefined
        }
    }

    private resetFileClient(profileId: string, expectedClient?: Client): void {
        const connection = this.connections.get(profileId)
        if (!connection || (expectedClient && connection.fileClient !== expectedClient)) return
        const client = connection.fileClient
        connection.fileClient = undefined
        connection.fileReady = undefined
        client?.destroy()
    }

    async exec(profileId: string, command: string, options: SshExecOptions = {}): Promise<PersistentCommandResult> {
        const attempts = options.retry ? 2 : 1
        let lastError: unknown
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await this.execOnce(profileId, command, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)
            } catch (error) {
                lastError = error
                if (attempt + 1 < attempts) this.resetManagementClient(profileId)
            }
        }
        throw lastError
    }

    private async execOnce(profileId: string, command: string, timeoutMs: number): Promise<PersistentCommandResult> {
        const client = await this.managementClient(profileId)
        return await new Promise((resolve, reject) => {
            let settled = false
            let channel: ClientChannel | undefined
            const settle = (error?: unknown, result?: PersistentCommandResult): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (error) reject(error)
                else resolve(result!)
            }
            const timer = setTimeout(() => {
                const timeoutError = new Error(`SSH 命令执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`)
                settle(timeoutError)
                channel?.destroy()
                this.resetManagementClient(profileId, client)
            }, timeoutMs)
            client.exec(command, (error, openedChannel) => {
                if (error) return settle(error)
                channel = openedChannel
                let stdout = ''
                let stderr = ''
                channel.setEncoding('utf8')
                channel.on('data', (data: string) => { stdout += data })
                channel.stderr.setEncoding('utf8')
                channel.stderr.on('data', (data: string) => { stderr += data })
                channel.on('error', settle)
                channel.on('close', (code: number | null) => settle(undefined, { stdout, stderr, code }))
            })
        })
    }

    async execPersistent(profileId: string, command: string, options: SshExecOptions = {}): Promise<PersistentCommandResult> {
        const attempts = options.retry ? 2 : 1
        let lastError: unknown
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await this.queuePersistentCommand(profileId, command, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)
            } catch (error) {
                lastError = error
                if (attempt + 1 < attempts) this.resetManagementClient(profileId)
            }
        }
        throw lastError
    }

    private async queuePersistentCommand(profileId: string, command: string, timeoutMs: number): Promise<PersistentCommandResult> {
        const connection = this.connections.get(profileId)
        if (!connection || connection.status.status !== 'connected') throw new Error('服务器尚未连接')
        const previous = connection.commandQueue ?? Promise.resolve()
        const running = previous.catch(() => undefined).then(async () => await this.runPersistentCommand(profileId, command, timeoutMs))
        connection.commandQueue = running.then(() => undefined, () => undefined)
        return await running
    }

    private async runPersistentCommand(profileId: string, command: string, timeoutMs: number): Promise<PersistentCommandResult> {
        const shell = await this.persistentCommandShell(profileId)
        const marker = `__MUXBOARD_${randomUUID().replace(/-/gu, '')}__`
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (shell.pending?.marker === marker) shell.pending = undefined
                this.resetManagementClient(profileId)
                reject(new Error(`SSH 命令执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`))
            }, timeoutMs)
            shell.pending = { marker, timer, resolve, reject }
            shell.channel.write(`{ ${command}; } 2>&1\n__muxboard_code=$?\nprintf '\\n${marker}:%s\\n' "$__muxboard_code"\n`)
        })
    }

    private async persistentCommandShell(profileId: string): Promise<PersistentCommandShell> {
        const connection = this.connections.get(profileId)
        if (!connection || connection.status.status !== 'connected') throw new Error('服务器尚未连接')
        if (connection.commandShell) return connection.commandShell
        const client = await this.managementClient(profileId)
        return await new Promise((resolve, reject) => {
            let settled = false
            const settleError = (error: unknown): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(error)
            }
            const timer = setTimeout(() => {
                this.resetManagementClient(profileId, client)
                settleError(new Error('SSH 持久命令通道打开超时'))
            }, PERSISTENT_SHELL_OPEN_TIMEOUT_MS)
            client.exec('sh', (error, channel) => {
                if (error) return settleError(error)
                if (this.connections.get(profileId) !== connection || connection.managementClient !== client) {
                    channel.destroy()
                    return settleError(new Error('SSH 管理连接已失效'))
                }
                settled = true
                clearTimeout(timer)
                channel.setEncoding('utf8')
                const shell: PersistentCommandShell = { channel, buffer: '' }
                connection.commandShell = shell
                channel.on('data', (data: string) => this.consumePersistentOutput(shell, data))
                channel.stderr.setEncoding('utf8')
                channel.stderr.on('data', (data: string) => this.consumePersistentOutput(shell, data))
                channel.on('error', (channelError: Error) => this.closePersistentShell(connection, shell, channelError))
                channel.once('close', () => this.closePersistentShell(connection, shell, new Error('SSH 持久命令通道已关闭')))
                resolve(shell)
            })
        })
    }

    private consumePersistentOutput(shell: PersistentCommandShell, data: string): void {
        shell.buffer += data
        const pending = shell.pending
        if (!pending) return
        const prefix = `\n${pending.marker}:`
        const markerIndex = shell.buffer.indexOf(prefix)
        if (markerIndex < 0) return
        const lineEnd = shell.buffer.indexOf('\n', markerIndex + prefix.length)
        if (lineEnd < 0) return
        const codeText = shell.buffer.slice(markerIndex + prefix.length, lineEnd).trim()
        const code = Number.parseInt(codeText, 10)
        const stdout = shell.buffer.slice(0, markerIndex)
        shell.buffer = shell.buffer.slice(lineEnd + 1)
        shell.pending = undefined
        clearTimeout(pending.timer)
        const normalizedCode = Number.isFinite(code) ? code : null
        pending.resolve({ stdout, stderr: normalizedCode === 0 ? '' : stdout, code: normalizedCode })
    }

    private closePersistentShell(connection: ActiveConnection, shell: PersistentCommandShell, error: Error): void {
        if (connection.commandShell === shell) connection.commandShell = undefined
        if (!shell.pending) return
        clearTimeout(shell.pending.timer)
        shell.pending.reject(error)
        shell.pending = undefined
    }

    async terminal(profileId: string, command: string, cols: number, rows: number): Promise<ClientChannel> {
        const client = this.client(profileId)
        return await new Promise((resolve, reject) => {
            client.exec(command, { pty: { term: 'xterm-256color', cols, rows } }, (error, channel) => {
                if (error) reject(error)
                else resolve(channel)
            })
        })
    }

    async sftp(profileId: string): Promise<SFTPWrapper> {
        let lastError: unknown
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const client = await this.fileTransferClient(profileId)
            try {
                return await new Promise((resolve, reject) => {
                    let settled = false
                    const settle = (error?: unknown, sftp?: SFTPWrapper): void => {
                        if (settled) return
                        settled = true
                        clearTimeout(timer)
                        if (error) reject(error)
                        else resolve(sftp!)
                    }
                    const timer = setTimeout(() => {
                        settle(new Error('SFTP 通道打开超时'))
                        this.resetFileClient(profileId, client)
                    }, SFTP_OPEN_TIMEOUT_MS)
                    client.sftp((error, sftp) => error ? settle(error) : settle(undefined, sftp))
                })
            } catch (error) {
                lastError = error
                if (attempt === 0) this.resetFileClient(profileId)
            }
        }
        throw lastError
    }

    async home(profileId: string): Promise<string> {
        const connection = this.connections.get(profileId)
        if (!connection) throw new Error('服务器尚未连接')
        if (connection.home) return connection.home
        const result = await this.exec(profileId, 'printf %s "$HOME"')
        if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '无法读取远端主目录')
        connection.home = result.stdout
        return connection.home
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
