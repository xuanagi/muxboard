import { describe, expect, test } from 'bun:test'
import { friendlyErrorNotice, friendlySshErrorMessage } from './friendly-error'

describe('friendlyErrorNotice', () => {
    test('turns a lost handshake into an actionable message', () => {
        expect(friendlySshErrorMessage(new Error('Connection lost before handshake'))).toBe(
            'SSH 连接未能完成握手，请检查网络或服务器状态后重试。'
        )
    })

    test('does not expose stack traces or local paths for unexpected errors', () => {
        const error = new Error('Failed in C:\\Users\\alice\\AppData\\Local\\Programs\\Muxboard')
        error.stack = `${error.message}\n    at secret (C:\\Users\\alice\\private.ts:12:3)`

        const notice = friendlyErrorNotice(error)

        expect(notice.zh).not.toContain('C:\\Users')
        expect(notice.en).not.toContain('private.ts')
        expect(notice.zh).toContain('意外错误')
    })

    test('provides specific guidance for common connection failures', () => {
        expect(friendlySshErrorMessage('connect ETIMEDOUT')).toContain('超时')
        expect(friendlySshErrorMessage('connect ECONNREFUSED')).toContain('拒绝')
        expect(friendlySshErrorMessage('getaddrinfo ENOTFOUND host')).toContain('解析')
        expect(friendlySshErrorMessage('All configured authentication methods failed')).toContain('身份验证')
    })
})
