import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { shuffle } from 'es-toolkit'
import type { Song, PlayMode } from '../types'
import { APP_CONFIG } from '../config'

export type QueueSource = 'liked' | 'local' | 'history' | 'hidden'

interface PlayerSettings {
  volume: number
  playMode: PlayMode
}

interface PlayerSettingsStore {
  settings: PlayerSettings
  setVolume: (volume: number) => void
  setPlayMode: (mode: PlayMode) => void
}

export const usePlayerSettingsStore = create<PlayerSettingsStore>()(
  persist(
    (set) => ({
      settings: {
        volume: APP_CONFIG.player.defaultVolume,
        playMode: 'list',
      },
      setVolume: (volume) =>
        set((state) => ({
          settings: { ...state.settings, volume },
        })),
      setPlayMode: (playMode) =>
        set((state) => ({
          settings: { ...state.settings, playMode },
        })),
    }),
    {
      name: 'player-settings',
    }
  )
)

interface PlayQueueState {
  queue: Song[]
  currentIndex: number
  originalQueue: Song[]
  queueSource: QueueSource
  lastSongPath: string | null
}

interface PlayQueueStore extends PlayQueueState {
  setQueue: (songs: Song[], startIndex?: number, source?: QueueSource) => void
  addToQueue: (song: Song) => void
  addBatchToQueue: (songs: Song[]) => void
  addToQueueNext: (song: Song) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  moveInQueue: (fromIndex: number, toIndex: number) => void

  getCurrentSong: () => Song | null
  getNextSong: (mode: PlayMode) => Song | null
  getPrevSong: (mode: PlayMode) => Song | null
  moveToNext: (mode: PlayMode) => Song | null
  moveToPrev: (mode: PlayMode) => Song | null

  shuffleQueue: () => void
  unshuffleQueue: () => void
  toggleShuffle: () => void

  setLastSongPath: (path: string | null) => void
  setCurrentIndex: (index: number) => void
}

function shuffleTracksKeepCurrent<T extends { path: string }>(tracks: T[], currentIndex: number): T[] {
  if (tracks.length === 0) return tracks
  // 边界保护：currentIndex 越界时直接打乱全部
  if (currentIndex < 0 || currentIndex >= tracks.length) {
    return shuffle(tracks)
  }
  const current = tracks[currentIndex]
  const rest = tracks.filter((_, i) => i !== currentIndex)
  return [current, ...shuffle(rest)]
}

export const usePlayQueueStore = create<PlayQueueStore>()(
  persist(
    (set, get) => ({
      queue: [],
      currentIndex: -1,
      originalQueue: [],
      queueSource: 'local',
      lastSongPath: null,

      setQueue: (songs, startIndex = 0, source = 'local') => {
        const { settings } = usePlayerSettingsStore.getState()
        if (settings.playMode === 'shuffle' && songs.length > 1) {
          const shuffled = shuffleTracksKeepCurrent(songs, startIndex)
          set({
            queue: shuffled,
            originalQueue: songs,
            currentIndex: 0,
            queueSource: source,
          })
        } else {
          set({
            queue: songs,
            originalQueue: songs,
            currentIndex: startIndex,
            queueSource: source,
          })
        }
      },

      addToQueue: (song) => {
        set((state) => ({
          queue: [...state.queue, song],
          originalQueue: [...state.originalQueue, song],
        }))
      },

      addBatchToQueue: (songs) => {
        if (songs.length === 0) return
        set((state) => ({
          queue: [...state.queue, ...songs],
          originalQueue: [...state.originalQueue, ...songs],
        }))
      },

      addToQueueNext: (song) => {
        set((state) => {
          // 空队列或未播放时，queue 和 originalQueue 都追加到尾部，保持一致
          if (state.currentIndex < 0) {
            return {
              queue: [...state.queue, song],
              originalQueue: [...state.originalQueue, song],
            }
          }

          const newQueue = [...state.queue]
          const insertIndex = state.currentIndex + 1
          newQueue.splice(insertIndex, 0, song)

          const newOriginalQueue = [...state.originalQueue]
          const currentSong = state.queue[state.currentIndex]
          const origCurrentIndex = currentSong
            ? newOriginalQueue.findIndex((s) => s.path === currentSong.path)
            : newOriginalQueue.length
          newOriginalQueue.splice(origCurrentIndex + 1, 0, song)

          return {
            queue: newQueue,
            originalQueue: newOriginalQueue,
          }
        })
      },

      removeFromQueue: (index) => {
        set((state) => {
          if (index < 0 || index >= state.queue.length) return state

          const removedPath = state.queue[index].path
          const newQueue = state.queue.filter((_, i) => i !== index)
          const origIndex = state.originalQueue.findIndex((s) => s.path === removedPath)
          const newOriginalQueue = [...state.originalQueue]
          if (origIndex >= 0) newOriginalQueue.splice(origIndex, 1)
          let newIndex = state.currentIndex

          if (index < state.currentIndex) {
            newIndex = state.currentIndex - 1
          } else if (index === state.currentIndex) {
            newIndex = Math.min(state.currentIndex, newQueue.length - 1)
            // 删除当前播放歌曲时联动 playerStore，避免 UI 残留被删除歌曲
            // 动态 import 避免循环依赖（playQueueStore ↔ playerStore）
            void import('./playerStore').then(({ usePlayerStore }) => {
              const playerState = usePlayerStore.getState()
              if (newQueue.length === 0) {
                // C2 修复：队列空时必须停止后端，否则音频继续播放但 UI 显示无歌
                void playerState.stop()
                usePlayerStore.setState({ currentSong: null, duration: 0 })
              } else {
                const newSong = newQueue[newIndex]
                if (playerState.isPlaying) {
                  // 播放中：切到新位置的歌并继续播放
                  void playerState.playSongAtIndex(newIndex)
                } else {
                  // C1 修复：暂停态下也必须停止后端并重置 backendLoaded，
                  // 否则下次 togglePlay 会走 resume 分支恢复已删除歌曲
                  void playerState.stop()
                  usePlayerStore.setState({ currentSong: newSong, duration: newSong.duration })
                }
              }
            })
          }

          return {
            queue: newQueue,
            originalQueue: newOriginalQueue,
            currentIndex: newIndex,
          }
        })
      },

      clearQueue: () => {
        set({
          queue: [],
          originalQueue: [],
          currentIndex: -1,
        })
      },

      moveInQueue: (fromIndex, toIndex) => {
        set((state) => {
          // fromIndex === toIndex 时无需移动，提前返回避免 originalQueue 计算错乱
          if (
            fromIndex < 0 ||
            fromIndex >= state.queue.length ||
            toIndex < 0 ||
            toIndex >= state.queue.length ||
            fromIndex === toIndex
          ) {
            return state
          }

          const newQueue = [...state.queue]
          const [removed] = newQueue.splice(fromIndex, 1)
          newQueue.splice(toIndex, 0, removed)

          const movedSong = state.queue[fromIndex]
          const origFromIndex = state.originalQueue.findIndex((s) => s.path === movedSong.path)
          const newOriginalQueue = [...state.originalQueue]
          if (origFromIndex >= 0) {
            const [origRemoved] = newOriginalQueue.splice(origFromIndex, 1)
            const targetSong = state.queue[toIndex]
            const origToIndex = targetSong
              ? newOriginalQueue.findIndex((s) => s.path === targetSong.path)
              : -1
            // fromIndex < toIndex 时，目标歌曲在 newOriginalQueue 中已左移，
            // 移动歌曲应插入到目标歌曲之后（origToIndex + 1）以保持与 queue 一致的相对顺序
            const insertPos = origToIndex >= 0
              ? (fromIndex < toIndex ? origToIndex + 1 : origToIndex)
              : newOriginalQueue.length
            newOriginalQueue.splice(insertPos, 0, origRemoved)
          }

          let newIndex = state.currentIndex
          if (fromIndex === state.currentIndex) {
            newIndex = toIndex
          } else if (fromIndex < state.currentIndex && toIndex >= state.currentIndex) {
            newIndex = state.currentIndex - 1
          } else if (fromIndex > state.currentIndex && toIndex <= state.currentIndex) {
            newIndex = state.currentIndex + 1
          }

          return {
            queue: newQueue,
            originalQueue: newOriginalQueue,
            currentIndex: newIndex,
          }
        })
      },

      getCurrentSong: () => {
        const { queue, currentIndex } = get()
        if (currentIndex >= 0 && currentIndex < queue.length) {
          return queue[currentIndex]
        }
        return null
      },

      getNextSong: (mode) => {
        const { queue, currentIndex } = get()
        if (queue.length === 0) return null

        if (mode === 'loop') {
          return queue[currentIndex] || null
        }

        const nextIndex = (currentIndex + 1) % queue.length
        return queue[nextIndex]
      },

      getPrevSong: (mode) => {
        const { queue, currentIndex } = get()
        if (queue.length === 0) return null

        if (mode === 'loop') {
          return queue[currentIndex] || null
        }

        const prevIndex = (currentIndex - 1 + queue.length) % queue.length
        return queue[prevIndex]
      },

      moveToNext: (mode) => {
        const { queue, currentIndex } = get()
        if (queue.length === 0) return null

        let newIndex: number

        if (mode === 'loop') {
          newIndex = currentIndex
        } else {
          newIndex = (currentIndex + 1) % queue.length
        }

        const song = queue[newIndex]
        set({ currentIndex: newIndex, lastSongPath: song?.path || null })
        return song ?? null
      },

      moveToPrev: (mode) => {
        const { queue, currentIndex } = get()
        if (queue.length === 0) return null

        let newIndex: number

        if (mode === 'loop') {
          newIndex = currentIndex
        } else {
          newIndex = (currentIndex - 1 + queue.length) % queue.length
        }

        const song = queue[newIndex]
        set({ currentIndex: newIndex, lastSongPath: song?.path || null })
        return song ?? null
      },

      shuffleQueue: () => {
        set((state) => {
          if (state.queue.length <= 1) return state

          const shuffled = shuffleTracksKeepCurrent(state.queue, state.currentIndex)

          return {
            queue: shuffled,
            // currentIndex < 0（未播放）时保持 -1，避免 shuffle 后错误选中第一首
            currentIndex: state.currentIndex < 0 ? -1 : 0,
          }
        })
      },

      unshuffleQueue: () => {
        set((state) => {
          if (state.originalQueue.length === 0) return state

          const currentSong = state.queue[state.currentIndex]
          const newIndex = state.originalQueue.findIndex((s) => s.path === currentSong?.path)

          return {
            queue: [...state.originalQueue],
            currentIndex: newIndex >= 0 ? newIndex : 0,
          }
        })
      },

      toggleShuffle: () => {
        const { settings } = usePlayerSettingsStore.getState()
        const isShuffled = settings.playMode === 'shuffle'

        if (isShuffled) {
          get().unshuffleQueue()
          usePlayerSettingsStore.getState().setPlayMode('list')
        } else {
          get().shuffleQueue()
          usePlayerSettingsStore.getState().setPlayMode('shuffle')
        }
      },

      setLastSongPath: (path) => {
        set({ lastSongPath: path })
      },

      setCurrentIndex: (index) => {
        set({ currentIndex: index })
      },
    }),
    {
      name: 'play-queue',
      partialize: (state) => ({
        lastSongPath: state.lastSongPath,
        queueSource: state.queueSource,
      }),
    }
  )
)
