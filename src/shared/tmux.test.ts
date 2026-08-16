import { describe, expect, it } from 'bun:test'
import { parseTmuxRows, shellQuote, TMUX_FIELD_SEPARATOR } from './tmux'

describe('tmux protocol helpers', () => {
    it('parses the session hierarchy', () => {
        const row = [
            '$1', 'project', '1', '100', '@1', '0', 'agent', '1', 'layout', '1', '0', '0',
            '%1', '0', 'codex', 'codex', '/srv/project', '321', '1', '0', '120', '40'
        ].join(TMUX_FIELD_SEPARATOR)
        const snapshot = parseTmuxRows(row, 'tmux 3.2a')
        expect(snapshot.sessions[0]?.windows[0]?.panes[0]?.currentCommand).toBe('codex')
        expect(snapshot.sessions[0]?.attached).toBe(1)
        expect(snapshot.sessions[0]?.windows[0]?.alert).toBe('activity')
    })

    it('quotes shell values', () => {
        expect(shellQuote("team's api")).toBe("'team'\\''s api'")
    })
})
