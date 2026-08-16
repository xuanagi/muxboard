import { describe, expect, test } from 'bun:test'
import type { ProfileStore } from './profile-store'
import { SshManager } from './ssh-manager'

type FramingShell = {
    buffer: string
    pending?: {
        marker: string
        timer: ReturnType<typeof setTimeout>
        resolve: (result: { stdout: string; stderr: string; code: number | null }) => void
        reject: (error: Error) => void
    }
}

describe('SshManager persistent command framing', () => {
    test('waits for a complete marker and extracts the exit code', async () => {
        const manager = new SshManager({} as ProfileStore)
        const consume = (manager as unknown as {
            consumePersistentOutput(shell: FramingShell, data: string): void
        }).consumePersistentOutput.bind(manager)
        let resolveResult!: (result: { stdout: string; stderr: string; code: number | null }) => void
        const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => { resolveResult = resolve })
        const shell: FramingShell = {
            buffer: '',
            pending: {
                marker: '__MUXBOARD_TEST__',
                timer: setTimeout(() => undefined, 10_000),
                resolve: resolveResult,
                reject: () => undefined
            }
        }

        consume(shell, 'tmux 3.4\n\n__MUX')
        expect(shell.pending).toBeDefined()
        consume(shell, 'BOARD_TEST__:0\n')

        expect(await result).toEqual({ stdout: 'tmux 3.4\n', stderr: '', code: 0 })
        expect(shell.pending).toBeUndefined()
        expect(shell.buffer).toBe('')
    })

    test('exposes failed command output as stderr', async () => {
        const manager = new SshManager({} as ProfileStore)
        const consume = (manager as unknown as {
            consumePersistentOutput(shell: FramingShell, data: string): void
        }).consumePersistentOutput.bind(manager)
        let resolveResult!: (result: { stdout: string; stderr: string; code: number | null }) => void
        const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => { resolveResult = resolve })
        const shell: FramingShell = {
            buffer: '',
            pending: {
                marker: '__MUXBOARD_FAILURE__',
                timer: setTimeout(() => undefined, 10_000),
                resolve: resolveResult,
                reject: () => undefined
            }
        }

        consume(shell, 'no server running\n__MUXBOARD_FAILURE__:1\n')

        expect(await result).toEqual({ stdout: 'no server running', stderr: 'no server running', code: 1 })
    })
})
