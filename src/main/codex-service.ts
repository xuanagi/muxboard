import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import { ProfileStore } from './profile-store'
import { SshManager } from './ssh-manager'

function shellQuote(value: string): string {
    return "'" + value.replace(/'/gu, "'\"'\"'") + "'"
}

function tomlString(value: string): string {
    return JSON.stringify(value)
}

function writeFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), { mode: 0o600 }, (error) => error ? reject(error) : resolve()))
}

/** Applies one locally stored provider as the connected server user's Codex default. */
export class CodexService {
    constructor(private readonly ssh: SshManager, private readonly profiles: ProfileStore) {}

    async apply(profileId: string, codexProfileId: string): Promise<void> {
        const server = await this.profiles.get(profileId)
        const profile = server.codexProfiles.find((item) => item.id === codexProfileId)
        if (!profile) throw new Error('Codex 配置不存在')
        const apiKey = await this.profiles.codexSecret(profileId, codexProfileId)
        if (!apiKey) throw new Error('该 Codex 配置尚未保存 API Key')

        const config = [
            '# Managed by Muxboard. The previous config is backed up before each switch.',
            'model_provider = "muxboard"',
            `model = ${tomlString(profile.model)}`,
            '',
            '[model_providers.muxboard]',
            `name = ${tomlString(profile.name)}`,
            `base_url = ${tomlString(profile.baseUrl.replace(/\/+$/u, ''))}`,
            'wire_api = "responses"',
            `experimental_bearer_token = ${tomlString(apiKey)}`,
            ''
        ].join('\n')

        const home = await this.ssh.home(profileId)
        const directory = `${home}/.codex`
        const backupDirectory = `${directory}/muxboard-backups`
        const target = `${directory}/config.toml`
        const temporary = `${directory}/.muxboard-config-${randomUUID()}.tmp`
        const backupStamp = new Date().toISOString().replace(/[:.]/gu, '-')

        const prepare = await this.ssh.exec(profileId, [
            'set -eu',
            `mkdir -p ${shellQuote(directory)} ${shellQuote(backupDirectory)}`,
            `chmod 700 ${shellQuote(directory)} ${shellQuote(backupDirectory)}`,
            `[ ! -f ${shellQuote(target)} ] || cp -p ${shellQuote(target)} ${shellQuote(`${backupDirectory}/config-${backupStamp}.toml`)}`
        ].join('; '))
        if (prepare.code !== 0) throw new Error(prepare.stderr.trim() || '无法准备远端 Codex 配置目录')

        try {
            const sftp = await this.ssh.sftp(profileId)
            try {
                await writeFile(sftp, temporary, config)
            } finally {
                sftp.end()
            }
            const replace = await this.ssh.exec(profileId, `set -eu; chmod 600 ${shellQuote(temporary)}; mv -f ${shellQuote(temporary)} ${shellQuote(target)}`)
            if (replace.code !== 0) throw new Error(replace.stderr.trim() || '无法写入远端 config.toml')
        } catch (error) {
            await this.ssh.exec(profileId, `rm -f ${shellQuote(temporary)}`).catch(() => undefined)
            throw error
        }

        await this.profiles.setActiveCodexProfile(profileId, codexProfileId)
    }
}
