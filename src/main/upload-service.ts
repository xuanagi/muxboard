import { clipboard, dialog } from 'electron'
import { basename, extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import type { UploadResult } from '../shared/types'
import { SshManager } from './ssh-manager'

export class UploadService {
    constructor(private readonly ssh: SshManager) {}

    async clipboardImage(profileId: string): Promise<UploadResult> {
        const image = clipboard.readImage()
        if (image.isEmpty()) throw new Error('剪贴板中没有图片')
        const buffer = image.toPNG()
        const name = `screenshot-${Date.now()}.png`
        return await this.upload(profileId, name, buffer, 'image/png')
    }

    async chooseFile(profileId: string, destinationDirectory?: string): Promise<UploadResult | null> {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        const filePath = result.filePaths[0]
        if (result.canceled || !filePath) return null
        const [buffer, info] = await Promise.all([readFile(filePath), stat(filePath)])
        return await this.upload(profileId, basename(filePath), buffer, this.mimeType(filePath), info.size, destinationDirectory)
    }

    private async upload(profileId: string, name: string, buffer: Buffer, mimeType: string, size = buffer.length, destinationDirectory?: string): Promise<UploadResult> {
        const home = await this.ssh.home(profileId)
        const date = new Date().toISOString().slice(0, 10)
        const directory = `${home}/.cache/muxboard/uploads/${date}`
        const safeName = name.replace(/[^a-zA-Z0-9._-]/gu, '_')
        const targetDirectory = destinationDirectory?.replace(/\/+$/u, '') || directory
        let uploadedName = destinationDirectory ? name : `${Date.now()}-${safeName}`
        let remotePath = `${targetDirectory}/${uploadedName}`
        const sftp = await this.ssh.sftp(profileId)
        try {
            if (!destinationDirectory) await this.mkdirRecursive(sftp, directory)
            if (destinationDirectory && await this.pathExists(sftp, remotePath)) {
                const choice = await dialog.showMessageBox({
                    type: 'question',
                    title: '同名文件已存在',
                    message: `当前目录已存在同名文件：${name}`,
                    detail: '替换会覆盖远端旧文件；自动重命名会保留旧文件。',
                    buttons: ['替换', '自动重命名', '取消'],
                    defaultId: 0,
                    cancelId: 2,
                    noLink: true
                })
                if (choice.response === 2) throw new Error('已取消上传')
                if (choice.response === 1) {
                    uploadedName = await this.availableName(sftp, targetDirectory, name)
                    remotePath = `${targetDirectory}/${uploadedName}`
                }
            }
            await new Promise<void>((resolve, reject) => {
                const stream = sftp.createWriteStream(remotePath, { mode: 0o600 })
                stream.on('error', reject)
                stream.once('close', resolve)
                stream.end(buffer)
            })
            if (!await this.pathExists(sftp, remotePath)) throw new Error(`上传后未在远端找到文件：${remotePath}`)
        } finally {
            sftp.end()
        }
        return { localName: uploadedName, remotePath, size, mimeType }
    }

    private async availableName(sftp: SFTPWrapper, directory: string, name: string): Promise<string> {
        const extension = extname(name)
        const stem = extension ? name.slice(0, -extension.length) : name
        for (let index = 1; index <= 9_999; index += 1) {
            const candidate = `${stem}-${index}${extension}`
            if (!await this.pathExists(sftp, `${directory}/${candidate}`)) return candidate
        }
        throw new Error('无法生成可用的文件名')
    }

    private async pathExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
        return await new Promise((resolve, reject) => sftp.stat(remotePath, (error) => {
            if (!error) resolve(true)
            else {
                const code = (error as unknown as { code?: string | number }).code
                if (code === 'ENOENT' || code === 2 || code === '2') resolve(false)
                else reject(error)
            }
        }))
    }

    private async mkdirRecursive(sftp: SFTPWrapper, directory: string): Promise<void> {
        const parts = directory.split('/').filter(Boolean)
        let current = directory.startsWith('/') ? '' : '.'
        for (const part of parts) {
            current = current === '' ? `/${part}` : `${current}/${part}`
            await new Promise<void>((resolve, reject) => {
                sftp.stat(current, (statError) => {
                    if (!statError) return resolve()
                    sftp.mkdir(current, { mode: 0o700 }, (mkdirError) => mkdirError ? reject(mkdirError) : resolve())
                })
            })
        }
    }

    private mimeType(filePath: string): string {
        const extension = extname(filePath).toLowerCase()
        return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf' } as Record<string, string>)[extension] || 'application/octet-stream'
    }
}
