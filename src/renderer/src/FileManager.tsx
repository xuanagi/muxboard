import { useEffect, useRef, useState } from 'react'
import type { AppLanguage, FileManagerEntry, FileManagerListing, FileTransferDirection, FileTransferEvent } from '../../shared/types'

type Props = {
    profileId: string
    serverName: string
    initialRemotePath?: string
    language: AppLanguage
    onError: (message: string) => void
    onRequestOverwrite: (targetPath: string, confirm: () => Promise<void>) => void
}

type Side = 'local' | 'remote'

const dragType = 'application/x-muxboard-file'

const labels = {
    en: {
        local: 'LOCAL COMPUTER', remote: 'REMOTE SERVER', path: 'Path', up: 'Up', refresh: 'Refresh', browse: 'Browse', go: 'Go',
        name: 'Name', size: 'Size', modified: 'Modified', empty: 'This directory is empty', loading: 'Loading…',
        upload: 'Upload', download: 'Download', hint: 'Drag files or folders to the other side to copy them', transfers: 'TRANSFERS',
        cancel: 'Cancel', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', running: 'Transferring', transferableOnly: 'Only files and folders can be transferred.',
        multiSelect: 'Ctrl-click to select multiple items · Shift-click to select a range'
    },
    zh: {
        local: '本地电脑', remote: '远端服务器', path: '路径', up: '上级', refresh: '刷新', browse: '选择目录', go: '转到',
        name: '名称', size: '大小', modified: '修改时间', empty: '当前目录为空', loading: '读取中…',
        upload: '上传', download: '下载', hint: '将文件或文件夹拖到另一侧即可复制', transfers: '传输任务',
        cancel: '取消', completed: '已完成', cancelled: '已取消', failed: '失败', running: '传输中', transferableOnly: '只能传输文件或文件夹。',
        multiSelect: '按住 Ctrl 点击可多选 · 按住 Shift 点击可连续选择'
    }
} as const

function message(error: unknown): string {
    if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
    return String(error)
}

function formatSize(size: number): string {
    if (size < 1024) return `${size} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = size / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function parentOf(targetPath: string, side: Side): string {
    const separator = side === 'remote' ? '/' : targetPath.includes('\\') ? '\\' : '/'
    const index = targetPath.lastIndexOf(separator)
    if (side === 'remote') return index <= 0 ? '/' : targetPath.slice(0, index)
    if (index < 0) return targetPath
    if (index === 2 && targetPath[1] === ':') return targetPath.slice(0, 3)
    return targetPath.slice(0, index)
}

export function FileManager({ profileId, serverName, initialRemotePath, language, onError, onRequestOverwrite }: Props): React.JSX.Element {
    const text = labels[language]
    const [localListing, setLocalListing] = useState<FileManagerListing | null>(null)
    const [remoteListing, setRemoteListing] = useState<FileManagerListing | null>(null)
    const [localPath, setLocalPath] = useState('')
    const [remotePath, setRemotePath] = useState('')
    const [localDraft, setLocalDraft] = useState('')
    const [remoteDraft, setRemoteDraft] = useState('')
    const [localLoading, setLocalLoading] = useState(true)
    const [remoteLoading, setRemoteLoading] = useState(true)
    const [localError, setLocalError] = useState<string | null>(null)
    const [remoteError, setRemoteError] = useState<string | null>(null)
    const [selectedLocal, setSelectedLocal] = useState<Set<string>>(() => new Set())
    const [selectedRemote, setSelectedRemote] = useState<Set<string>>(() => new Set())
    const [dropTarget, setDropTarget] = useState<Side | null>(null)
    const [transfers, setTransfers] = useState<FileTransferEvent[]>([])
    const localPathRef = useRef('')
    const remotePathRef = useRef('')
    const localRequestRef = useRef(0)
    const remoteRequestRef = useRef(0)
    const localSelectionAnchorRef = useRef<string | null>(null)
    const remoteSelectionAnchorRef = useRef<string | null>(null)

    const loadLocal = async (nextPath: string): Promise<void> => {
        const request = ++localRequestRef.current
        setLocalLoading(true)
        setLocalError(null)
        try {
            const listing = await window.muxboard.files.listLocal(nextPath)
            if (request !== localRequestRef.current) return
            localPathRef.current = listing.path
            setLocalPath(listing.path)
            setLocalDraft(listing.path)
            setLocalListing(listing)
            setSelectedLocal(new Set())
            localSelectionAnchorRef.current = null
        } catch (error) {
            if (request === localRequestRef.current) setLocalError(message(error))
        } finally {
            if (request === localRequestRef.current) setLocalLoading(false)
        }
    }

    const loadRemote = async (nextPath: string): Promise<void> => {
        const request = ++remoteRequestRef.current
        setRemoteLoading(true)
        setRemoteError(null)
        try {
            const listing = await window.muxboard.files.listRemote(profileId, nextPath)
            if (request !== remoteRequestRef.current) return
            remotePathRef.current = listing.path
            setRemotePath(listing.path)
            setRemoteDraft(listing.path)
            setRemoteListing(listing)
            setSelectedRemote(new Set())
            remoteSelectionAnchorRef.current = null
        } catch (error) {
            if (request === remoteRequestRef.current) setRemoteError(message(error))
        } finally {
            if (request === remoteRequestRef.current) setRemoteLoading(false)
        }
    }

    useEffect(() => {
        let active = true
        setLocalListing(null)
        setRemoteListing(null)
        setTransfers([])
        void window.muxboard.files.initialPaths(profileId, initialRemotePath).then((paths) => {
            if (!active) return
            void loadLocal(paths.localPath)
            void loadRemote(paths.remotePath)
        }).catch((error) => { if (active) onError(message(error)) })
        return () => { active = false }
    }, [profileId, initialRemotePath])

    useEffect(() => window.muxboard.files.onTransfer((event) => {
        if (event.profileId !== profileId) return
        setTransfers((current) => {
            const next = current.filter((item) => item.transferId !== event.transferId)
            return [event, ...next].slice(0, 8)
        })
        if (event.status !== 'completed') return
        if (event.direction === 'upload' && parentOf(event.targetPath, 'remote') === remotePathRef.current) void loadRemote(remotePathRef.current)
        if (event.direction === 'download' && parentOf(event.targetPath, 'local') === localPathRef.current) void loadLocal(localPathRef.current)
    }), [profileId])

    const startTransfer = async (entry: FileManagerEntry, direction: FileTransferDirection, overwrite = false): Promise<void> => {
        if (entry.type !== 'file' && entry.type !== 'directory') return onError(text.transferableOnly)
        try {
            const result = await window.muxboard.files.startTransfer({
                profileId,
                direction,
                sourcePath: entry.path,
                destinationDirectory: direction === 'upload' ? remotePathRef.current : localPathRef.current,
                overwrite
            })
            if (result.status === 'conflict') {
                onRequestOverwrite(result.targetPath, async () => { await startTransfer(entry, direction, true) })
            }
        } catch (error) { onError(message(error)) }
    }

    const selectedEntries = (side: Side): FileManagerEntry[] => {
        const listing = side === 'local' ? localListing : remoteListing
        const selected = side === 'local' ? selectedLocal : selectedRemote
        return listing?.entries.filter((entry) => selected.has(entry.path)) ?? []
    }

    const startSelectedTransfers = async (side: Side, direction: FileTransferDirection): Promise<void> => {
        for (const entry of selectedEntries(side).filter((entry) => entry.type === 'file' || entry.type === 'directory')) await startTransfer(entry, direction)
    }

    const selectEntry = (side: Side, entry: FileManagerEntry, event: React.MouseEvent<HTMLButtonElement>): void => {
        const isLocal = side === 'local'
        const current = isLocal ? selectedLocal : selectedRemote
        const setSelected = isLocal ? setSelectedLocal : setSelectedRemote
        const anchorRef = isLocal ? localSelectionAnchorRef : remoteSelectionAnchorRef
        const listing = isLocal ? localListing : remoteListing
        const additive = event.ctrlKey || event.metaKey

        if (event.shiftKey && listing) {
            const anchorIndex = listing.entries.findIndex((item) => item.path === anchorRef.current)
            const targetIndex = listing.entries.findIndex((item) => item.path === entry.path)
            if (anchorIndex >= 0 && targetIndex >= 0) {
                const range = listing.entries.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
                setSelected(new Set(additive ? [...current, ...range.map((item) => item.path)] : range.map((item) => item.path)))
                return
            }
        }

        if (additive) {
            const next = new Set(current)
            if (next.has(entry.path)) next.delete(entry.path)
            else next.add(entry.path)
            setSelected(next)
        } else setSelected(new Set([entry.path]))
        anchorRef.current = entry.path
    }

    const browseLocal = async (): Promise<void> => {
        const chosen = await window.muxboard.files.chooseLocalDirectory()
        if (chosen) await loadLocal(chosen)
    }

    const dragStart = (event: React.DragEvent, side: Side, entry: FileManagerEntry): void => {
        if (entry.type !== 'file' && entry.type !== 'directory') { event.preventDefault(); return }
        event.dataTransfer.effectAllowed = 'copy'
        const entries = selectedEntries(side)
        const draggedEntries = entries.some((item) => item.path === entry.path) ? entries : [entry]
        if (draggedEntries.length === 1 && draggedEntries[0].path === entry.path) {
            if (side === 'local') setSelectedLocal(new Set([entry.path]))
            else setSelectedRemote(new Set([entry.path]))
        }
        event.dataTransfer.setData(dragType, JSON.stringify({ side, entries: draggedEntries }))
    }

    const allowDrop = (event: React.DragEvent, side: Side): void => {
        if (!event.dataTransfer.types.includes(dragType)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropTarget(side)
    }

    const drop = (event: React.DragEvent, side: Side): void => {
        event.preventDefault()
        setDropTarget(null)
        try {
            const value = JSON.parse(event.dataTransfer.getData(dragType)) as { side: Side; entries: FileManagerEntry[] }
            if (value.side === side) return
            void (async () => { for (const entry of value.entries) await startTransfer(entry, value.side === 'local' ? 'upload' : 'download') })()
        } catch { /* Ignore unrelated drag payloads. */ }
    }

    return <div className="file-manager">
        <div className="file-manager-title"><span className="file-manager-glyph">▣</span><strong>{serverName}</strong><span>{text.hint}</span><span>{text.multiSelect}</span></div>
        <div className="file-manager-columns">
            <FilePanel
                side="local" title={text.local} listing={localListing} path={localPath} draft={localDraft} loading={localLoading} error={localError}
                selected={selectedLocal} isDropTarget={dropTarget === 'local'} labels={text}
                transferableSelectionCount={selectedEntries('local').filter((entry) => entry.type === 'file' || entry.type === 'directory').length}
                onDraft={setLocalDraft} onGo={() => void loadLocal(localDraft)} onUp={() => localListing?.parentPath && void loadLocal(localListing.parentPath)}
                onRefresh={() => void loadLocal(localPath)} onBrowse={() => void browseLocal()} onSelect={selectEntry}
                onOpen={(entry) => entry.type === 'directory' && void loadLocal(entry.path)} onDragStart={dragStart}
                onDragOver={allowDrop} onDragLeave={() => setDropTarget(null)} onDrop={drop}
                onTransfer={() => void startSelectedTransfers('local', 'upload')}
            />
            <div className="file-transfer-divider" aria-hidden="true"><span>⇄</span></div>
            <FilePanel
                side="remote" title={`${text.remote} · ${serverName}`} listing={remoteListing} path={remotePath} draft={remoteDraft} loading={remoteLoading} error={remoteError}
                selected={selectedRemote} isDropTarget={dropTarget === 'remote'} labels={text}
                transferableSelectionCount={selectedEntries('remote').filter((entry) => entry.type === 'file' || entry.type === 'directory').length}
                onDraft={setRemoteDraft} onGo={() => void loadRemote(remoteDraft)} onUp={() => remoteListing?.parentPath && void loadRemote(remoteListing.parentPath)}
                onRefresh={() => void loadRemote(remotePath)} onSelect={selectEntry}
                onOpen={(entry) => entry.type === 'directory' && void loadRemote(entry.path)} onDragStart={dragStart}
                onDragOver={allowDrop} onDragLeave={() => setDropTarget(null)} onDrop={drop}
                onTransfer={() => void startSelectedTransfers('remote', 'download')}
            />
        </div>
        {transfers.length > 0 && <div className="transfer-queue">
            <div className="transfer-queue-heading">{text.transfers}</div>
            {transfers.map((transfer) => {
                const percent = transfer.totalBytes > 0 ? Math.min(100, transfer.transferredBytes / transfer.totalBytes * 100) : 0
                const stateLabel = transfer.status === 'completed' ? text.completed : transfer.status === 'cancelled' ? text.cancelled : transfer.status === 'error' ? text.failed : text.running
                return <div className={`transfer-row is-${transfer.status}`} key={transfer.transferId}>
                    <span className="transfer-direction">{transfer.direction === 'upload' ? '→' : '←'}</span>
                    <span className="transfer-name" title={transfer.targetPath}>{transfer.currentPath ? `${transfer.name} / ${transfer.currentPath}` : transfer.name}</span>
                    <div className="transfer-progress"><i style={{ width: `${percent}%` }} /></div>
                    <span className="transfer-size">{formatSize(transfer.transferredBytes)} / {formatSize(transfer.totalBytes)}</span>
                    <span className="transfer-state" title={transfer.error}>{stateLabel}</span>
                    {transfer.status === 'running' && <button onClick={() => void window.muxboard.files.cancelTransfer(transfer.transferId)}>{text.cancel}</button>}
                </div>
            })}
        </div>}
    </div>
}

type PanelProps = {
    side: Side
    title: string
    listing: FileManagerListing | null
    path: string
    draft: string
    loading: boolean
    error: string | null
    selected: Set<string>
    transferableSelectionCount: number
    isDropTarget: boolean
    labels: typeof labels.en | typeof labels.zh
    onDraft: (value: string) => void
    onGo: () => void
    onUp: () => void
    onRefresh: () => void
    onBrowse?: () => void
    onSelect: (side: Side, entry: FileManagerEntry, event: React.MouseEvent<HTMLButtonElement>) => void
    onOpen: (entry: FileManagerEntry) => void
    onDragStart: (event: React.DragEvent, side: Side, entry: FileManagerEntry) => void
    onDragOver: (event: React.DragEvent, side: Side) => void
    onDragLeave: () => void
    onDrop: (event: React.DragEvent, side: Side) => void
    onTransfer: () => void
}

function FilePanel(props: PanelProps): React.JSX.Element {
    const directionLabel = props.side === 'local' ? props.labels.upload : props.labels.download
    return <section
        className={`file-panel ${props.isDropTarget ? 'is-drop-target' : ''}`}
        onDragOver={(event) => props.onDragOver(event, props.side)} onDragLeave={props.onDragLeave} onDrop={(event) => props.onDrop(event, props.side)}
    >
        <header className="file-panel-header">
            <strong>{props.title}</strong>
            <div className="file-panel-actions">
                <button disabled={!props.listing?.parentPath} onClick={props.onUp}>↑ {props.labels.up}</button>
                <button onClick={props.onRefresh}>↻ {props.labels.refresh}</button>
                {props.onBrowse && <button onClick={props.onBrowse}>… {props.labels.browse}</button>}
                <button className="primary-button" disabled={props.transferableSelectionCount === 0} onClick={props.onTransfer}>{props.side === 'local' ? '→' : '←'} {directionLabel}</button>
            </div>
        </header>
        <form className="file-path-bar" onSubmit={(event) => { event.preventDefault(); props.onGo() }}>
            <span>{props.labels.path}</span>
            <input value={props.draft} onChange={(event) => props.onDraft(event.target.value)} spellCheck={false} />
            <button type="submit">{props.labels.go}</button>
        </form>
        <div className="file-list-heading"><span>{props.labels.name}</span><span>{props.labels.size}</span><span>{props.labels.modified}</span></div>
        <div className="file-list">
            {props.loading && <div className="file-list-message"><span className="button-spinner">◌</span>{props.labels.loading}</div>}
            {!props.loading && props.error && <div className="file-list-message is-error">{props.error}</div>}
            {!props.loading && !props.error && props.listing?.entries.length === 0 && <div className="file-list-message">{props.labels.empty}</div>}
            {!props.loading && !props.error && props.listing?.entries.map((entry) => <button
                key={entry.path} className={`file-row ${props.selected.has(entry.path) ? 'is-selected' : ''}`}
                draggable={entry.type === 'file' || entry.type === 'directory'} onDragStart={(event) => props.onDragStart(event, props.side, entry)}
                onClick={(event) => props.onSelect(props.side, entry, event)} onDoubleClick={() => props.onOpen(entry)} title={entry.path}
            >
                <span className={`file-icon is-${entry.type}`}>{entry.type === 'directory' ? '▰' : entry.type === 'symlink' ? '↗' : '▪'}</span>
                <span className="file-name">{entry.name}</span>
                <span className="file-size">{entry.type === 'file' ? formatSize(entry.size) : ''}</span>
                <span className="file-modified">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}</span>
            </button>)}
        </div>
        {props.isDropTarget && <div className="file-drop-overlay">{directionLabel}</div>}
    </section>
}
