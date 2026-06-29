// 从 ts-rs 自动生成的类型重新导出（与后端 Rust 结构体保持一致）
// 运行 `npm run gen:types` 重新生成
import type { Song } from './types/generated/Song'
export type { Song }

export type ViewType = 'liked' | 'history' | 'local' | 'hidden' | 'settings'

export type PlayMode = 'list' | 'loop' | 'shuffle'

/**
 * UI 层的播放器状态。
 * 注意：与后端 `PlayerState`（src/types/generated/PlayerState.ts）不同，
 * 后者描述后端播放器的实际状态，前端通过 `BackendPlayerState` 别名引用。
 */
export interface PlayerState {
  currentSong: Song | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playMode: PlayMode
}

export interface LibraryState {
  songs: Song[]
  likedPaths: Set<string>
  hiddenPaths: Set<string>
  isLoading: boolean
}
