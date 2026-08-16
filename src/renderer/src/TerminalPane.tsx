import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { AppTheme, TerminalTab } from '../../shared/types'

type Props = {
    tab: TerminalTab
    visible: boolean
    fontSize: number
    theme: AppTheme
    onFontSizeDelta: (delta: number) => void
    onExit: (terminalId: string) => void
}

const terminalThemes = {
    black: {
        background: '#10110f', foreground: '#d8d9d2', cursor: '#efc84a', cursorAccent: '#10110f', selectionBackground: '#4b4630',
        black: '#161713', red: '#e06c64', green: '#98c379', yellow: '#efc84a', blue: '#79a8d8', magenta: '#bf83c9', cyan: '#74c7b8', white: '#d8d9d2',
        brightBlack: '#686a61', brightRed: '#f07b72', brightGreen: '#acd48b', brightYellow: '#ffdb63', brightBlue: '#91bcea', brightMagenta: '#d19adc', brightCyan: '#8dd8ca', brightWhite: '#f1f2ec'
    },
    gray: {
        background: '#1b1d20', foreground: '#e2e5e9', cursor: '#e8bd56', cursorAccent: '#1b1d20', selectionBackground: '#4a4d52',
        black: '#24272b', red: '#f07872', green: '#a9cc7c', yellow: '#e8bd56', blue: '#88b8e8', magenta: '#d39bdf', cyan: '#80cec2', white: '#e2e5e9',
        brightBlack: '#858a91', brightRed: '#ff938d', brightGreen: '#c0e592', brightYellow: '#ffdb70', brightBlue: '#a4cdf5', brightMagenta: '#e3b2ee', brightCyan: '#9de1d6', brightWhite: '#ffffff'
    },
    light: {
        background: '#f6f5f1', foreground: '#252722', cursor: '#a06e00', cursorAccent: '#f6f5f1', selectionBackground: '#eadfae',
        black: '#2d302a', red: '#b83b35', green: '#4f7d23', yellow: '#9a6800', blue: '#356fa8', magenta: '#8d4d9d', cyan: '#177b70', white: '#e8e7e0',
        brightBlack: '#6e7169', brightRed: '#d4524a', brightGreen: '#639c2d', brightYellow: '#b87f00', brightBlue: '#4e89c4', brightMagenta: '#a766b7', brightCyan: '#278f82', brightWhite: '#ffffff'
    }
} as const

export function TerminalPane({ tab, visible, fontSize, theme, onFontSizeDelta, onExit }: Props): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const wheelDeltaRef = useRef(0)

    useEffect(() => {
        const terminal = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
            fontSize,
            lineHeight: 1.2,
            scrollback: 10_000,
            allowProposedApi: false,
            theme: terminalThemes[theme]
        })
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(containerRef.current!)
        terminalRef.current = terminal
        fitRef.current = fit
        requestAnimationFrame(() => {
            fit.fit()
            void window.muxboard.terminal.resize(tab.id, terminal.cols, terminal.rows)
            terminal.focus()
        })

        const inputDisposable = terminal.onData((data) => void window.muxboard.terminal.input(tab.id, data))
        let selectionCopyTimer: number | undefined
        let selectingWithShift = false
        const copySelection = (): void => {
            const selectedText = terminal.getSelection()
            if (selectedText) void window.muxboard.clipboard.writeText(selectedText).catch(() => undefined)
        }
        const scheduleSelectionCopy = (): void => {
            if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer)
            selectionCopyTimer = window.setTimeout(() => {
                requestAnimationFrame(copySelection)
            }, 0)
        }
        const stopData = window.muxboard.terminal.onData((event) => {
            if (event.terminalId === tab.id) terminal.write(event.data)
        })
        const stopExit = window.muxboard.terminal.onExit((event) => {
            if (event.terminalId !== tab.id) return
            terminal.writeln(`\r\n\x1b[33m[连接已断开，远端 tmux 会话仍在运行]\x1b[0m`)
            onExit(tab.id)
        })
        const observer = new ResizeObserver(() => {
            if (!visible) return
            fit.fit()
            void window.muxboard.terminal.resize(tab.id, terminal.cols, terminal.rows)
        })
        observer.observe(containerRef.current!)
        const handleWheel = (event: WheelEvent): void => {
            if (!event.ctrlKey) return
            event.preventDefault()
            event.stopPropagation()
            wheelDeltaRef.current += event.deltaY
            if (Math.abs(wheelDeltaRef.current) < 40) return
            const delta = wheelDeltaRef.current < 0 ? 1 : -1
            wheelDeltaRef.current -= Math.sign(wheelDeltaRef.current) * 40
            onFontSizeDelta(delta)
        }
        const pasteText = (text: string): void => {
            // A terminal interprets CR/LF as Enter. Keep multi-line clipboard text on
            // the current command line so pasting into Codex never submits it early.
            const normalized = text.replace(/\r\n?|\n/gu, ' ').replace(/\u0000/gu, '')
            if (normalized) void window.muxboard.terminal.input(tab.id, normalized)
        }
        const handlePasteShortcut = (event: KeyboardEvent): void => {
            if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'v') return
            event.preventDefault()
            event.stopPropagation()
            void window.muxboard.clipboard.text().then(pasteText).catch(() => undefined)
        }
        const handlePaste = (event: ClipboardEvent): void => {
            const text = event.clipboardData?.getData('text/plain')
            if (text === undefined) return
            event.preventDefault()
            pasteText(text)
        }
        const handleMouseDown = (event: MouseEvent): void => {
            selectingWithShift = event.button === 0 && event.shiftKey
        }
        const handleMouseUp = (): void => {
            if (!selectingWithShift) return
            selectingWithShift = false
            // tmux mouse mode owns ordinary drags. Holding Shift makes xterm
            // create a local selection; read it after xterm finishes mouseup.
            scheduleSelectionCopy()
        }
        containerRef.current!.addEventListener('wheel', handleWheel, { passive: false })
        containerRef.current!.addEventListener('keydown', handlePasteShortcut, true)
        containerRef.current!.addEventListener('paste', handlePaste, true)
        containerRef.current!.addEventListener('mousedown', handleMouseDown, true)
        window.addEventListener('mouseup', handleMouseUp, true)

        return () => {
            observer.disconnect()
            containerRef.current?.removeEventListener('wheel', handleWheel)
            containerRef.current?.removeEventListener('keydown', handlePasteShortcut, true)
            containerRef.current?.removeEventListener('paste', handlePaste, true)
            containerRef.current?.removeEventListener('mousedown', handleMouseDown, true)
            window.removeEventListener('mouseup', handleMouseUp, true)
            inputDisposable.dispose()
            if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer)
            stopData()
            stopExit()
            terminal.dispose()
        }
    }, [tab.id])

    useEffect(() => {
        const terminal = terminalRef.current
        const fit = fitRef.current
        if (!terminal || !fit) return
        terminal.options.fontSize = fontSize
        requestAnimationFrame(() => {
            fit.fit()
            void window.muxboard.terminal.resize(tab.id, terminal.cols, terminal.rows)
        })
    }, [fontSize, tab.id])

    useEffect(() => {
        const terminal = terminalRef.current
        if (terminal) terminal.options.theme = terminalThemes[theme]
    }, [theme])

    useEffect(() => {
        if (!visible || !terminalRef.current || !fitRef.current) return
        requestAnimationFrame(() => {
            fitRef.current?.fit()
            const terminal = terminalRef.current
            if (terminal) {
                void window.muxboard.terminal.resize(tab.id, terminal.cols, terminal.rows)
                terminal.focus()
            }
        })
    }, [visible, tab.id])

    return <div
        ref={containerRef}
        className={`terminal-pane ${visible ? 'is-visible' : ''}`}
        title="Shift + 鼠标拖选：自动复制 / Shift + drag: auto-copy"
    />
}
