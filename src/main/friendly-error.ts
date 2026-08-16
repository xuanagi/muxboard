import type { AppErrorNotice, AppLanguage } from '../shared/types'

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return ''
}

export function friendlyErrorNotice(error: unknown): AppErrorNotice {
    const message = errorMessage(error)

    if (/handshake|kex_exchange_identification|identification string/iu.test(message)) {
        return {
            zh: 'SSH 连接未能完成握手，请检查网络或服务器状态后重试。',
            en: 'The SSH handshake could not be completed. Check the network or server and try again.'
        }
    }
    if (/authentication|permission denied|all configured authentication methods failed/iu.test(message)) {
        return {
            zh: 'SSH 身份验证失败，请检查用户名和登录凭据。',
            en: 'SSH authentication failed. Check the username and credentials.'
        }
    }
    if (/econnrefused|connection refused/iu.test(message)) {
        return {
            zh: '服务器拒绝了 SSH 连接，请检查地址、端口和 SSH 服务。',
            en: 'The server refused the SSH connection. Check its address, port, and SSH service.'
        }
    }
    if (/timed?\s*out|etimedout/iu.test(message)) {
        return {
            zh: '连接服务器超时，请检查网络后重试。',
            en: 'The server connection timed out. Check the network and try again.'
        }
    }
    if (/econnreset|connection (?:lost|closed)|socket hang up|write epipe/iu.test(message)) {
        return {
            zh: '与服务器的连接已中断，请检查网络后重试。远端 tmux 会话不会因此结束。',
            en: 'The server connection was interrupted. Check the network and try again. Remote tmux sessions are unaffected.'
        }
    }
    if (/enotfound|getaddrinfo|name or service not known/iu.test(message)) {
        return {
            zh: '无法解析服务器地址，请检查主机名和网络设置。',
            en: 'The server address could not be resolved. Check the host name and network settings.'
        }
    }

    return {
        zh: 'Muxboard 遇到意外错误，请重试；如果问题持续，请重新启动应用。',
        en: 'Muxboard encountered an unexpected error. Try again, or restart the app if the problem continues.'
    }
}

export function friendlySshErrorMessage(error: unknown, language: AppLanguage = 'zh'): string {
    return friendlyErrorNotice(error)[language]
}
