import type { MuxboardDesktopApi } from '../../shared/types'

declare global {
    interface Window {
        muxboard: MuxboardDesktopApi
    }
}

export {}
