import type { TmuxSession, TmuxSnapshot, TmuxWindow } from './types'

export const TMUX_FIELD_SEPARATOR = '\u001f'

function asInteger(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) ? parsed : 0
}

export function parseTmuxRows(rows: string, tmuxVersion: string | null = null): TmuxSnapshot {
    const sessions = new Map<string, TmuxSession>()
    const windows = new Map<string, TmuxWindow>()

    for (const row of rows.split('\n')) {
        if (!row.trim()) continue
        const [
            sessionId,
            sessionName,
            sessionAttached,
            sessionCreated,
            windowId,
            windowIndex,
            windowName,
            windowActive,
            windowLayout,
            windowActivity,
            windowBell,
            windowSilence,
            paneId,
            paneIndex,
            paneTitle,
            paneCommand,
            panePath,
            panePid,
            paneActive,
            paneDead,
            paneWidth,
            paneHeight
        ] = row.split(TMUX_FIELD_SEPARATOR)

        if (!sessionId || !windowId || !paneId) continue

        let session = sessions.get(sessionId)
        if (!session) {
            session = {
                id: sessionId,
                name: sessionName || sessionId,
                attached: asInteger(sessionAttached),
                createdAt: asInteger(sessionCreated) * 1000,
                windows: []
            }
            sessions.set(sessionId, session)
        }

        let window = windows.get(windowId)
        if (!window) {
            window = {
                id: windowId,
                index: asInteger(windowIndex),
                name: windowName || windowId,
                active: windowActive === '1',
                layout: windowLayout || '',
                alert: windowBell === '1' ? 'bell' : windowActivity === '1' ? 'activity' : windowSilence === '1' ? 'silence' : 'none',
                panes: []
            }
            windows.set(windowId, window)
            session.windows.push(window)
        }

        window.panes.push({
            id: paneId,
            index: asInteger(paneIndex),
            title: paneTitle || '',
            currentCommand: paneCommand || '',
            currentPath: panePath || '',
            pid: panePid ? asInteger(panePid) : null,
            active: paneActive === '1',
            dead: paneDead === '1',
            width: asInteger(paneWidth),
            height: asInteger(paneHeight)
        })
    }

    return {
        sessions: [...sessions.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((session) => ({
                ...session,
                windows: session.windows
                    .sort((left, right) => left.index - right.index)
                    .map((window) => ({
                        ...window,
                        panes: window.panes.sort((left, right) => left.index - right.index)
                    }))
            })),
        tmuxVersion,
        capturedAt: Date.now()
    }
}

export function tmuxInventoryFormat(): string {
    return [
        '#{session_id}', '#{session_name}', '#{session_attached}', '#{session_created}',
        '#{window_id}', '#{window_index}', '#{window_name}', '#{window_active}', '#{window_layout}', '#{window_activity_flag}', '#{window_bell_flag}', '#{window_silence_flag}',
        '#{pane_id}', '#{pane_index}', '#{pane_title}', '#{pane_current_command}', '#{pane_current_path}',
        '#{pane_pid}', '#{pane_active}', '#{pane_dead}', '#{pane_width}', '#{pane_height}'
    ].join(TMUX_FIELD_SEPARATOR)
}

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}
