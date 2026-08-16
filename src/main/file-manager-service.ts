import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WebContents } from 'electron'
import { dialog } from 'electron'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { FileManagerEntry, FileManagerListing, FileTransferEvent, StartFileTransferInput, StartFileTransferResult } from '../shared/types'
import { SshManager } from './ssh-manager'

type ActiveTransfer = {
    profileId: string
    controller: AbortController
}

type TransferFile = {
    sourcePath: string
    targetPath: string
    relativePath: string
    size: number
}

type TransferTree = {
    directories: string[]
    files: TransferFile[]
}

type BrowseSftpSession = {
    sftp?: SFTPWrapper
    opening?: Promise<SFTPWrapper>
    idleTimer?: ReturnType<typeof setTimeout>
}

const BROWSE_SFTP_IDLE_MS = 60_000
const REMOTE_LIST_TIMEOUT_MS = 15_000

export class FileManagerService {
    private readonly transfers = new Map<string, ActiveTransfer>()
    private readonly browseSessions = new Map<string, BrowseSftpSession>()

    constructor(
        private readonly ssh: SshManager,
        private readonly webContents: () => WebContents | undefined
    ) {}

    async initialPaths(profileId: string, preferredRemotePath?: string): Promise<{ localPath: string; remotePath: string }> {
        return {
            localPath: homedir(),
            remotePath: preferredRemotePath ? this.remotePath(preferredRemotePath) : await this.ssh.home(profileId)
        }
    }

    async listLocal(rawPath: string): Promise<FileManagerListing> {
        const directory = this.localPath(rawPath)
        const directoryStat = await stat(directory)
        if (!directoryStat.isDirectory()) throw new Error(`Not a directory: ${directory}`)
        const items = await readdir(directory, { withFileTypes: true })
        const entries = await Promise.all(items.map(async (item): Promise<FileManagerEntry> => {
            const itemPath = path.join(directory, item.name)
            let itemStat
            try { itemStat = await stat(itemPath) } catch { itemStat = null }
            return {
                name: item.name,
                path: itemPath,
                type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'symlink' : 'other',
                size: itemStat?.size ?? 0,
                modifiedAt: itemStat?.mtimeMs ?? 0
            }
        }))
        return { path: directory, parentPath: this.localParent(directory), entries: this.sort(entries) }
    }

    async listRemote(profileId: string, rawPath: string): Promise<FileManagerListing> {
        const directory = this.remotePath(rawPath)
        const sftp = await this.browseSftp(profileId)
        try {
            const entries = await new Promise<FileManagerEntry[]>((resolve, reject) => {
                let settled = false
                const timer = setTimeout(() => {
                    if (settled) return
                    settled = true
                    this.closeBrowseSftp(profileId)
                    reject(new Error('读取远程目录超时'))
                }, REMOTE_LIST_TIMEOUT_MS)
                sftp.readdir(directory, (error, items) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    if (error) return reject(error)
                    resolve(items.map((item) => ({
                        name: item.filename,
                        path: path.posix.join(directory, item.filename),
                        type: item.attrs.isDirectory() ? 'directory' : item.attrs.isFile() ? 'file' : item.attrs.isSymbolicLink() ? 'symlink' : 'other',
                        size: item.attrs.size,
                        modifiedAt: item.attrs.mtime * 1000
                    })))
                })
            })
            this.scheduleBrowseSftpIdle(profileId)
            return { path: directory, parentPath: directory === '/' ? null : path.posix.dirname(directory), entries: this.sort(entries) }
        } catch (error) {
            // Path and permission errors do not invalidate the SFTP subsystem.
            // Transport failures are handled by the session's error/close events.
            this.scheduleBrowseSftpIdle(profileId)
            throw error
        }
    }

    async chooseLocalDirectory(): Promise<string | null> {
        const result = await dialog.showOpenDialog({ title: 'Choose local directory', properties: ['openDirectory'] })
        return result.canceled ? null : result.filePaths[0] ?? null
    }

    async startTransfer(input: StartFileTransferInput): Promise<StartFileTransferResult> {
        return input.direction === 'upload' ? await this.startUpload(input) : await this.startDownload(input)
    }

    cancelTransfer(transferId: string): void {
        this.transfers.get(transferId)?.controller.abort()
    }

    cancelForProfile(profileId: string): void {
        this.closeBrowseSftp(profileId)
        for (const transfer of this.transfers.values()) {
            if (transfer.profileId === profileId) transfer.controller.abort()
        }
    }

    cancelAll(): void {
        for (const profileId of [...this.browseSessions.keys()]) this.closeBrowseSftp(profileId)
        for (const transfer of this.transfers.values()) transfer.controller.abort()
    }

    private async browseSftp(profileId: string): Promise<SFTPWrapper> {
        let session = this.browseSessions.get(profileId)
        if (!session) {
            session = {}
            this.browseSessions.set(profileId, session)
        }
        if (session.idleTimer) clearTimeout(session.idleTimer)
        session.idleTimer = undefined
        if (session.sftp) return session.sftp
        if (!session.opening) {
            const target = session
            target.opening = this.ssh.sftp(profileId).then((sftp) => {
                if (this.browseSessions.get(profileId) !== target) {
                    sftp.end()
                    throw new Error('SFTP 浏览会话已失效')
                }
                target.sftp = sftp
                const invalidate = (): void => {
                    if (this.browseSessions.get(profileId) === target) this.closeBrowseSftp(profileId, false)
                }
                sftp.once('close', invalidate)
                sftp.once('end', invalidate)
                sftp.on('error', invalidate)
                return sftp
            }).finally(() => {
                if (this.browseSessions.get(profileId) === target) target.opening = undefined
            })
        }
        const opening = session.opening
        if (!opening) throw new Error('无法打开 SFTP 浏览会话')
        return await opening
    }

    private scheduleBrowseSftpIdle(profileId: string): void {
        const session = this.browseSessions.get(profileId)
        if (!session) return
        if (session.idleTimer) clearTimeout(session.idleTimer)
        session.idleTimer = setTimeout(() => this.closeBrowseSftp(profileId), BROWSE_SFTP_IDLE_MS)
    }

    private closeBrowseSftp(profileId: string, end = true): void {
        const session = this.browseSessions.get(profileId)
        if (!session) return
        this.browseSessions.delete(profileId)
        if (session.idleTimer) clearTimeout(session.idleTimer)
        if (end) session.sftp?.end()
    }

    private async startUpload(input: StartFileTransferInput): Promise<StartFileTransferResult> {
        const sourcePath = this.localPath(input.sourcePath)
        const destinationDirectory = this.remotePath(input.destinationDirectory)
        const sourceStat = await stat(sourcePath)
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('Only files and folders can be transferred')
        const name = path.basename(sourcePath)
        const targetPath = path.posix.join(destinationDirectory, name)
        const sftp = await this.ssh.sftp(input.profileId)
        if (!input.overwrite && await this.remoteExists(sftp, targetPath)) {
            sftp.end()
            return { status: 'conflict', targetPath }
        }
        let tree: TransferTree
        try {
            tree = sourceStat.isDirectory()
                ? await this.collectLocalTree(sourcePath, targetPath)
                : { directories: [], files: [{ sourcePath, targetPath, relativePath: name, size: sourceStat.size }] }
        } catch (error) { sftp.end(); throw error }
        const transferId = randomUUID()
        const controller = new AbortController()
        this.transfers.set(transferId, { profileId: input.profileId, controller })
        const event: FileTransferEvent = {
            transferId, profileId: input.profileId, direction: 'upload', name, sourcePath, targetPath,
            transferredBytes: 0, totalBytes: tree.files.reduce((total, file) => total + file.size, 0), status: 'running'
        }
        this.emit(event)
        void this.uploadTree(sftp, event, tree, controller.signal, Boolean(input.overwrite))
        return { status: 'started', transferId }
    }

    private async startDownload(input: StartFileTransferInput): Promise<StartFileTransferResult> {
        const sourcePath = this.remotePath(input.sourcePath)
        const destinationDirectory = this.localPath(input.destinationDirectory)
        const destinationStat = await stat(destinationDirectory)
        if (!destinationStat.isDirectory()) throw new Error(`Not a directory: ${destinationDirectory}`)
        const name = path.posix.basename(sourcePath)
        const targetPath = path.join(destinationDirectory, name)
        if (!input.overwrite && await this.localExists(targetPath)) return { status: 'conflict', targetPath }
        const sftp = await this.ssh.sftp(input.profileId)
        let sourceStat: Stats
        try { sourceStat = await this.remoteStat(sftp, sourcePath) } catch (error) { sftp.end(); throw error }
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) { sftp.end(); throw new Error('Only files and folders can be transferred') }
        let tree: TransferTree
        try {
            tree = sourceStat.isDirectory()
                ? await this.collectRemoteTree(sftp, sourcePath, targetPath)
                : { directories: [], files: [{ sourcePath, targetPath, relativePath: name, size: sourceStat.size }] }
        } catch (error) { sftp.end(); throw error }
        const transferId = randomUUID()
        const controller = new AbortController()
        this.transfers.set(transferId, { profileId: input.profileId, controller })
        const event: FileTransferEvent = {
            transferId, profileId: input.profileId, direction: 'download', name, sourcePath, targetPath,
            transferredBytes: 0, totalBytes: tree.files.reduce((total, file) => total + file.size, 0), status: 'running'
        }
        this.emit(event)
        void this.downloadTree(sftp, event, tree, controller.signal, Boolean(input.overwrite))
        return { status: 'started', transferId }
    }

    private async uploadTree(sftp: SFTPWrapper, event: FileTransferEvent, tree: TransferTree, signal: AbortSignal, overwrite: boolean): Promise<void> {
        try {
            for (const directory of tree.directories) {
                signal.throwIfAborted()
                await this.ensureRemoteDirectory(sftp, directory, overwrite)
            }
            let completedBytes = 0
            for (const file of tree.files) {
                signal.throwIfAborted()
                await this.uploadFile(sftp, file, event, completedBytes, signal, overwrite)
                completedBytes += file.size
            }
            this.emit({ ...event, transferredBytes: event.totalBytes, status: 'completed' })
        } catch (error) {
            this.emit({ ...event, status: this.aborted(error, signal) ? 'cancelled' : 'error', error: this.message(error) })
        } finally {
            this.transfers.delete(event.transferId)
            sftp.end()
        }
    }

    private async downloadTree(sftp: SFTPWrapper, event: FileTransferEvent, tree: TransferTree, signal: AbortSignal, overwrite: boolean): Promise<void> {
        try {
            for (const directory of tree.directories) {
                signal.throwIfAborted()
                await this.ensureLocalDirectory(directory, overwrite)
            }
            let completedBytes = 0
            for (const file of tree.files) {
                signal.throwIfAborted()
                await this.downloadFile(sftp, file, event, completedBytes, signal, overwrite)
                completedBytes += file.size
            }
            this.emit({ ...event, transferredBytes: event.totalBytes, status: 'completed' })
        } catch (error) {
            this.emit({ ...event, status: this.aborted(error, signal) ? 'cancelled' : 'error', error: this.message(error) })
        } finally {
            this.transfers.delete(event.transferId)
            sftp.end()
        }
    }

    private async uploadFile(sftp: SFTPWrapper, file: TransferFile, event: FileTransferEvent, completedBytes: number, signal: AbortSignal, overwrite: boolean): Promise<void> {
        const temporaryPath = `${file.targetPath}.muxboard-${event.transferId}.part`
        try {
            await pipeline(createReadStream(file.sourcePath), this.progressMeter(event, completedBytes, file), sftp.createWriteStream(temporaryPath, { mode: 0o600, flags: 'w' }), { signal })
            if (overwrite && await this.remoteExists(sftp, file.targetPath)) await this.remoteUnlink(sftp, file.targetPath)
            await this.remoteRename(sftp, temporaryPath, file.targetPath)
        } catch (error) {
            await this.remoteUnlink(sftp, temporaryPath).catch(() => undefined)
            throw error
        }
    }

    private async downloadFile(sftp: SFTPWrapper, file: TransferFile, event: FileTransferEvent, completedBytes: number, signal: AbortSignal, overwrite: boolean): Promise<void> {
        const temporaryPath = `${file.targetPath}.muxboard-${event.transferId}.part`
        try {
            await pipeline(sftp.createReadStream(file.sourcePath), this.progressMeter(event, completedBytes, file), createWriteStream(temporaryPath, { flags: 'w' }), { signal })
            if (overwrite && await this.localExists(file.targetPath)) await rm(file.targetPath, { force: true })
            await rename(temporaryPath, file.targetPath)
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined)
            throw error
        }
    }

    private progressMeter(event: FileTransferEvent, completedBytes: number, file: TransferFile): Transform {
        let transferredBytes = 0
        let lastEmittedAt = 0
        return new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                transferredBytes += chunk.length
                const now = Date.now()
                if (now - lastEmittedAt >= 100) {
                    lastEmittedAt = now
                    this.emit({ ...event, currentPath: file.relativePath, transferredBytes: completedBytes + transferredBytes, status: 'running' })
                }
                callback(null, chunk)
            }
        })
    }

    private async collectLocalTree(sourceRoot: string, targetRoot: string): Promise<TransferTree> {
        const tree: TransferTree = { directories: [targetRoot], files: [] }
        const visit = async (sourceDirectory: string, targetDirectory: string, relativeDirectory: string): Promise<void> => {
            const entries = await readdir(sourceDirectory, { withFileTypes: true })
            for (const entry of entries) {
                const sourcePath = path.join(sourceDirectory, entry.name)
                const targetPath = path.posix.join(targetDirectory, entry.name)
                const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
                if (entry.isDirectory()) {
                    tree.directories.push(targetPath)
                    await visit(sourcePath, targetPath, relativePath)
                } else if (entry.isFile()) {
                    const fileStat = await stat(sourcePath)
                    tree.files.push({ sourcePath, targetPath, relativePath, size: fileStat.size })
                } else if (entry.isSymbolicLink()) {
                    throw new Error(`Symbolic links are not supported in folder transfers: ${sourcePath}`)
                }
            }
        }
        await visit(sourceRoot, targetRoot, '')
        return tree
    }

    private async collectRemoteTree(sftp: SFTPWrapper, sourceRoot: string, targetRoot: string): Promise<TransferTree> {
        const tree: TransferTree = { directories: [targetRoot], files: [] }
        const visit = async (sourceDirectory: string, targetDirectory: string, relativeDirectory: string): Promise<void> => {
            const entries = await this.remoteReadDirectory(sftp, sourceDirectory)
            for (const entry of entries) {
                const sourcePath = path.posix.join(sourceDirectory, entry.filename)
                const targetPath = path.join(targetDirectory, entry.filename)
                const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.filename}` : entry.filename
                if (entry.attrs.isDirectory()) {
                    tree.directories.push(targetPath)
                    await visit(sourcePath, targetPath, relativePath)
                } else if (entry.attrs.isFile()) {
                    tree.files.push({ sourcePath, targetPath, relativePath, size: entry.attrs.size })
                } else if (entry.attrs.isSymbolicLink()) {
                    throw new Error(`Symbolic links are not supported in folder transfers: ${sourcePath}`)
                }
            }
        }
        await visit(sourceRoot, targetRoot, '')
        return tree
    }

    private async ensureRemoteDirectory(sftp: SFTPWrapper, directory: string, overwrite: boolean): Promise<void> {
        try {
            const existing = await this.remoteStat(sftp, directory)
            if (existing.isDirectory()) return
            if (!overwrite) throw new Error(`Target exists and is not a directory: ${directory}`)
            await this.remoteUnlink(sftp, directory)
        } catch (error) {
            if (!this.isNotFound(error)) throw error
        }
        const parent = path.posix.dirname(directory)
        if (parent !== directory && parent !== '/') await this.ensureRemoteDirectory(sftp, parent, false)
        await this.remoteMkdir(sftp, directory)
    }

    private async ensureLocalDirectory(directory: string, overwrite: boolean): Promise<void> {
        try {
            const existing = await stat(directory)
            if (existing.isDirectory()) return
            if (!overwrite) throw new Error(`Target exists and is not a directory: ${directory}`)
            await rm(directory, { force: true })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await mkdir(directory, { recursive: true })
    }

    private async remoteReadDirectory(sftp: SFTPWrapper, directory: string): Promise<Array<{ filename: string; attrs: Stats }>> {
        return await new Promise((resolve, reject) => sftp.readdir(directory, (error, entries) => error ? reject(error) : resolve(entries)))
    }

    private emit(event: FileTransferEvent): void {
        const contents = this.webContents()
        if (contents && !contents.isDestroyed()) contents.send('files:transfer', event)
    }

    private localPath(rawPath: string): string {
        if (!rawPath.trim()) throw new Error('Local path is required')
        return path.resolve(rawPath)
    }

    private remotePath(rawPath: string): string {
        const normalized = path.posix.normalize(rawPath.trim())
        if (!normalized.startsWith('/')) throw new Error('Remote path must be absolute')
        return normalized
    }

    private localParent(directory: string): string | null {
        const parent = path.dirname(directory)
        return parent === directory ? null : parent
    }

    private sort(entries: FileManagerEntry[]): FileManagerEntry[] {
        return entries.sort((left, right) => {
            if (left.type === 'directory' && right.type !== 'directory') return -1
            if (left.type !== 'directory' && right.type === 'directory') return 1
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        })
    }

    private async localExists(filePath: string): Promise<boolean> {
        try { await stat(filePath); return true } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
        }
    }

    private async remoteExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
        try { await this.remoteStat(sftp, remotePath); return true } catch (error) {
            if (this.isNotFound(error)) return false
            throw error
        }
    }

    private async remoteStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
        return await new Promise((resolve, reject) => sftp.stat(remotePath, (error, result) => error ? reject(error) : resolve(result)))
    }

    private async remoteUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
        return await new Promise((resolve, reject) => sftp.unlink(remotePath, (error) => error ? reject(error) : resolve()))
    }

    private async remoteMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
        return await new Promise((resolve, reject) => sftp.mkdir(remotePath, { mode: 0o700 }, (error) => error ? reject(error) : resolve()))
    }

    private async remoteRename(sftp: SFTPWrapper, sourcePath: string, targetPath: string): Promise<void> {
        return await new Promise((resolve, reject) => sftp.rename(sourcePath, targetPath, (error) => error ? reject(error) : resolve()))
    }

    private aborted(error: unknown, signal: AbortSignal): boolean {
        return signal.aborted || (error instanceof Error && error.name === 'AbortError')
    }

    private isNotFound(error: unknown): boolean {
        const code = (error as { code?: string | number }).code
        return code === 'ENOENT' || code === 2 || code === '2'
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
