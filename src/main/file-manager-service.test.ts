import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { SFTPWrapper } from 'ssh2'
import type { SshManager } from './ssh-manager'

mock.module('electron', () => ({ dialog: {} }))

class FakeSftp extends EventEmitter {
    ended = false
    readonly paths: string[] = []

    readdir(remotePath: string, callback: (error: Error | undefined, items: []) => void): void {
        this.paths.push(remotePath)
        callback(undefined, [])
    }

    end(): void {
        this.ended = true
        this.emit('end')
    }
}

describe('FileManagerService remote browsing', () => {
    test('reuses a profile SFTP session and closes it during cleanup', async () => {
        const { FileManagerService } = await import('./file-manager-service')
        const sftp = new FakeSftp()
        let opens = 0
        const ssh = {
            sftp: async () => { opens += 1; return sftp as unknown as SFTPWrapper }
        } as unknown as SshManager
        const service = new FileManagerService(ssh, () => undefined)

        await service.listRemote('profile-1', '/tmp')
        await service.listRemote('profile-1', '/var')

        expect(opens).toBe(1)
        expect(sftp.paths).toEqual(['/tmp', '/var'])
        expect(sftp.ended).toBeFalse()
        service.cancelAll()
        expect(sftp.ended).toBeTrue()
    })
})
