import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { ClientChannel } from 'ssh2'
import type { SshManager } from './ssh-manager'
import { TmuxService } from './tmux-service'

class FakeChannel extends EventEmitter {
    readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
    readonly writes: string[] = []
    ended = false

    setEncoding(): void {}
    setWindow(): void {}
    write(data: string): boolean { this.writes.push(data); return true }
    end(): void { this.ended = true; this.emit('close', 0) }
    destroy(): void { this.end() }
}

function noSessionSsh(commands: string[]): SshManager {
    const execute = async (_profileId: string, command: string) => {
        commands.push(command)
        if (command === 'tmux -V') return { stdout: 'tmux 3.4\n', stderr: '', code: 0 }
        return { stdout: '', stderr: 'no server running on /tmp/tmux-1000/default', code: 1 }
    }
    return {
        exec: execute,
        execPersistent: execute
    } as unknown as SshManager
}

describe('TmuxService snapshots', () => {
    test('caches the tmux version for repeated snapshots', async () => {
        const commands: string[] = []
        const service = new TmuxService(noSessionSsh(commands), () => undefined)

        const first = await service.snapshot('profile-1')
        const second = await service.snapshot('profile-1')

        expect(first.tmuxVersion).toBe('tmux 3.4')
        expect(second.tmuxVersion).toBe('tmux 3.4')
        expect(commands.filter((command) => command === 'tmux -V')).toHaveLength(1)
        expect(commands.filter((command) => command.startsWith('tmux list-panes'))).toHaveLength(2)
    })

    test('invalidates cached profile state when the profile closes', async () => {
        const commands: string[] = []
        const service = new TmuxService(noSessionSsh(commands), () => undefined)

        await service.snapshot('profile-1')
        service.closeForProfile('profile-1')
        await service.snapshot('profile-1')

        expect(commands.filter((command) => command === 'tmux -V')).toHaveLength(2)
    })
})

describe('TmuxService background terminals', () => {
    test('honors the disabled sleep policy and supports sleeping background terminals on demand', async () => {
        const channel = new FakeChannel()
        const ssh = { terminal: async () => channel as unknown as ClientChannel } as unknown as SshManager
        const service = new TmuxService(ssh, () => undefined)
        service.setBackgroundTerminalSleepMinutes(0)

        const tab = await service.attach('profile-1', 'server', 'session', 120, 36)
        await service.setActive(tab.id)
        await service.setActive(undefined)
        const internals = service as unknown as { terminals: Map<string, { sleepTimer?: ReturnType<typeof setTimeout> }> }

        expect(internals.terminals.get(tab.id)?.sleepTimer).toBeUndefined()
        expect(service.sleepBackgroundTerminals()).toBe(1)
        expect(channel.ended).toBeTrue()
        service.close(tab.id)
    })

    test('detaches an inactive terminal and wakes it with buffered input', async () => {
        const channels = [new FakeChannel(), new FakeChannel()]
        let terminalCalls = 0
        const ssh = {
            terminal: async () => channels[terminalCalls++] as unknown as ClientChannel
        } as unknown as SshManager
        const sent: Array<{ channel: string; payload: unknown }> = []
        const contents = { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } as unknown as WebContents
        const service = new TmuxService(ssh, () => contents)

        const tab = await service.attach('profile-1', 'server', 'session', 120, 36)
        await service.setActive(tab.id)
        await service.setActive(undefined)
        const internals = service as unknown as {
            terminals: Map<string, unknown>
            sleepTerminal(terminalId: string, terminal: unknown): void
        }
        const terminal = internals.terminals.get(tab.id)
        internals.sleepTerminal(tab.id, terminal)
        service.input(tab.id, 'queued input')

        expect(channels[0].ended).toBeTrue()
        expect(terminalCalls).toBe(1)
        await service.setActive(tab.id)

        expect(terminalCalls).toBe(2)
        expect(channels[1].writes).toEqual(['queued input'])
        expect(sent.some((event) => event.channel === 'terminal:data')).toBeTrue()
        service.close(tab.id)
    })
})
