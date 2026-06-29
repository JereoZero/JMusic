import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import type { Song } from '../types'
import * as api from '../api/modules'
import { usePlayQueueStore, usePlayerSettingsStore, QueueSource } from './playQueueStore'
import { debounce } from 'es-toolkit'
import { mutex } from 'async-mutex-lite'
import { useOperationLogStore } from './operationLogStore'
import { handleError } from '../utils/errorHandler'
import { toast } from 'sonner'

const log = (action: string, detail?: string, error?: string) => {
  useOperationLogStore.getState().log(action, detail, error)
}

const debouncedSetVolume = debounce(async (volume: number) => {
  try {
    await api.setVolume(volume)
  } catch (error) {
    log('设置音量失败', String(error))
  }
}, 100)

interface PlaybackProgressEvent {
  path: string
  position: number
  duration: number
}

interface PlayerStore {
  currentSong: Song | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number

  playSong: (song: Song, queue?: Song[], source?: QueueSource) => Promise<void>
  playSongAtIndex: (index: number) => Promise<void>
  togglePlay: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => Promise<void>
  playNext: () => Promise<void>
  playPrev: () => Promise<void>
  initMediaSession: () => void
  updateMediaSession: (song: Song) => void
  restoreLastSong: () => Promise<void>
  playRandomSong: () => Promise<void>
  initEventListeners: () => void
  cleanupEventListeners: () => void
  destroy: () => void
}

let animationFrameId: number | null = null
let lastUpdateTime = 0
let lastBackendSyncTime = 0
let eventListenersInitialized = false
let eventUnlistenPromises: Promise<() => void>[] = []
let currentPlayPath: string | null = null
let accumulatedPlayedMs = 0
let playOperationId = 0
// seek 操作专用 opId，避免并发 seek 互相不失效
let seekOpId = 0
let backendLoaded = false

function resetModuleState() {
  stopProgressTimer()
  eventUnlistenPromises.forEach((p) => {
    p.then((fn) => fn()).catch(() => {})
  })
  eventUnlistenPromises = []
  eventListenersInitialized = false
  currentPlayPath = null
  accumulatedPlayedMs = 0
  playOperationId = 0
  seekOpId = 0
  backendLoaded = false
  lastUpdateTime = 0
  lastBackendSyncTime = 0
  debouncedSetVolume.cancel()
}

async function finalizePlayHistory(completed: boolean) {
  const path = currentPlayPath
  if (!path) return
  // 立即快照并清空，避免并发调用（如 playSongInternal 连续触发）重复记录同一首歌
  const elapsed = Math.floor(accumulatedPlayedMs / 1000)
  currentPlayPath = null
  accumulatedPlayedMs = 0
  // addPlayHistory 串行执行，保证历史记录写入顺序
  await mutex('play-history', async () => {
    try {
      await api.addPlayHistory(path, elapsed, completed)
    } catch (e) {
      handleError(e, '记录播放历史')
    }
  })
}

function updateProgress() {
  const store = usePlayerStore.getState()
  if (!store.isPlaying || !store.currentSong) {
    animationFrameId = null
    return
  }

  const now = performance.now()
  const delta = (now - lastUpdateTime) / 1000
  lastUpdateTime = now

  accumulatedPlayedMs += delta * 1000

  const newTime = store.currentTime + delta
  const maxTime = store.duration ?? store.currentSong.duration ?? 0

  if (maxTime <= 0) {
    animationFrameId = requestAnimationFrame(updateProgress)
    return
  }

  if (newTime >= maxTime) {
    animationFrameId = null
    usePlayerStore.setState({ currentTime: maxTime })
  } else {
    usePlayerStore.setState({ currentTime: newTime })
    animationFrameId = requestAnimationFrame(updateProgress)
  }
}

function startProgressTimer() {
  if (animationFrameId !== null) return

  lastUpdateTime = performance.now()
  animationFrameId = requestAnimationFrame(updateProgress)
}

function stopProgressTimer() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
}

async function playSongInternal(song: Song, logAction: string) {
  const opId = ++playOperationId
  log(logAction, song.title)

  await finalizePlayHistory(false)

  if (opId !== playOperationId) return

  try {
    await api.playSong(song.path)
    if (opId !== playOperationId) return
    backendLoaded = true

    log('播放成功', song.title)
    usePlayerStore.setState({
      currentSong: song,
      isPlaying: true,
      currentTime: 0,
      duration: song.duration,
    })
    usePlayQueueStore.getState().setLastSongPath(song.path)
    lastUpdateTime = performance.now()
    currentPlayPath = song.path
    startProgressTimer()

    usePlayerStore.getState().updateMediaSession(song)
    return true
  } catch (error) {
    if (opId !== playOperationId) return
    handleError(error, '播放歌曲')
    log('播放失败', String(error))
    return false
  }
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: usePlayerSettingsStore.getState().settings.volume,

  playSong: async (song, queue, source = 'local') => {
    const queueStore = usePlayQueueStore.getState()

    if (queue && queue.length > 0) {
      const startIndex = queue.findIndex((s) => s.path === song.path)
      queueStore.setQueue(queue, startIndex >= 0 ? startIndex : 0, source)
    }

    await playSongInternal(song, '点击播放')
  },

  playSongAtIndex: async (index) => {
    const queueStore = usePlayQueueStore.getState()
    const song = queueStore.queue[index]
    if (!song) return

    queueStore.setCurrentIndex(index)
    await playSongInternal(song, `播放列表项 ${index}`)
  },

  togglePlay: async () => {
    const { isPlaying, currentSong } = get()

    log('点击播放/暂停', `当前状态: ${isPlaying ? '播放中' : '暂停中'}`)

    if (!currentSong) {
      log('无当前歌曲', '播放随机歌曲')
      await get().playRandomSong()
      return
    }

    const opId = ++playOperationId

    try {
      if (isPlaying) {
        log('后台执行', 'pauseSong()')
        await api.pauseSong()
        if (opId !== playOperationId) return
        stopProgressTimer()
        set({ isPlaying: false })
        log('暂停成功')
      } else {
        if (!backendLoaded) {
          log('后台执行', 'playSong() - 首次加载音频')
          await get().playSong(currentSong)
        } else {
          log('后台执行', 'resumeSong()')
          await api.resumeSong()
          if (opId !== playOperationId) return
          lastUpdateTime = performance.now()
          startProgressTimer()
          set({ isPlaying: true })
          log('恢复成功')
        }
      }
    } catch (error) {
      if (opId !== playOperationId) return
      log('操作失败', String(error))
      handleError(error, '播放切换')
    }
  },

  pause: async () => {
    if (!get().currentSong) return
    log('暂停播放')
    const opId = ++playOperationId
    try {
      await api.pauseSong()
      if (opId !== playOperationId) return
      log('后台执行', 'pauseSong()')
      stopProgressTimer()
      set({ isPlaying: false })
    } catch (error) {
      if (opId !== playOperationId) return
      log('暂停失败', String(error))
      handleError(error, '暂停')
    }
  },

  resume: async () => {
    const opId = ++playOperationId
    const { currentSong } = get()
    if (!currentSong) {
      await get().playRandomSong()
      return
    }

    if (!backendLoaded) {
      log('后台执行', 'playSong() - resume时首次加载音频')
      await get().playSong(currentSong)
      return
    }

    log('恢复播放')

    try {
      await api.resumeSong()
      if (opId !== playOperationId) return
      log('后台执行', 'resumeSong()')
      lastUpdateTime = performance.now()
      startProgressTimer()
      set({ isPlaying: true })
    } catch (error) {
      if (opId !== playOperationId) return
      log('恢复失败', String(error))
      handleError(error, '恢复播放')
    }
  },

  stop: async () => {
    log('停止播放')
    ++playOperationId
    await finalizePlayHistory(false)
    try {
      await api.stopSong()
      backendLoaded = false
      log('后台执行', 'stopSong()')
      stopProgressTimer()
      set({ isPlaying: false, currentTime: 0 })
    } catch (error) {
      log('停止失败', String(error))
      handleError(error, '停止')
    }
  },

  seek: async (time) => {
    if (!get().currentSong) return
    // seek 专用 opId：并发 seek 互相失效；同时检查 playOperationId 应对切歌
    const opId = ++seekOpId
    const playOpId = playOperationId
    log('拖动进度条', `${time.toFixed(1)}s`)
    const prevTime = usePlayerStore.getState().currentTime
    try {
      await api.seekSong(time)
      // 切歌或更新的 seek 发生后放弃旧 seek 结果
      if (opId !== seekOpId || playOpId !== playOperationId) return
      log('后台执行', `seekSong(${time.toFixed(1)})`)
      stopProgressTimer()
      set({ currentTime: time })
      // 重置累计播放时长为 seek 位置，避免 seek 期间的时间差被错误计入
      accumulatedPlayedMs = time * 1000
      lastUpdateTime = performance.now()
      startProgressTimer()
    } catch (error) {
      if (opId !== seekOpId || playOpId !== playOperationId) return
      log('跳转失败', String(error))
      // 回滚到跳转前的位置
      set({ currentTime: prevTime })
      // seek 失败后若仍在播放，重启进度计时器
      if (usePlayerStore.getState().isPlaying) {
        lastUpdateTime = performance.now()
        startProgressTimer()
      }
    }
  },

  setVolume: async (volume) => {
    // 钳制到 [0, 1]，防止 UI 误传越界值到后端
    const clamped = Math.max(0, Math.min(1, volume))
    log('调节音量', `${Math.round(clamped * 100)}%`)
    usePlayerSettingsStore.getState().setVolume(clamped)
    set({ volume: clamped })
    debouncedSetVolume(clamped)
  },

  playNext: async () => {
    log('点击下一首')
    const queueStore = usePlayQueueStore.getState()
    const { playMode } = usePlayerSettingsStore.getState().settings

    if (playMode === 'loop') {
      const current = get().currentSong
      if (current) {
        await playSongInternal(current, '下一首(单曲循环)')
      }
      return
    }

    const nextSong = queueStore.moveToNext(playMode)
    if (!nextSong) {
      log('没有下一首')
      return
    }

    await playSongInternal(nextSong, '下一首')
  },

  playPrev: async () => {
    log('点击上一首')
    const queueStore = usePlayQueueStore.getState()
    const { playMode } = usePlayerSettingsStore.getState().settings

    // 符合 macOS Music / Spotify 习惯：播放超过 3s 时"上一首"先回到本曲开头，
    // 只有在开头几秒才真正跳到上一首
    if (get().currentTime > 3) {
      log('回退到开头', '播放进度>3s')
      await get().seek(0)
      return
    }

    if (playMode === 'loop') {
      const current = get().currentSong
      if (current) {
        await playSongInternal(current, '上一首(单曲循环)')
      }
      return
    }

    const prevSong = queueStore.moveToPrev(playMode)
    if (!prevSong) {
      log('没有上一首')
      return
    }

    await playSongInternal(prevSong, '上一首')
  },

  initMediaSession: () => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession) return

    navigator.mediaSession.setActionHandler('play', () => {
      get().togglePlay()
    })

    navigator.mediaSession.setActionHandler('pause', () => {
      get().pause()
    })

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      get().playPrev()
    })

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      get().playNext()
    })

    navigator.mediaSession.setActionHandler('seekto', (details: { seekTime?: number }) => {
      if (details.seekTime !== undefined) {
        get().seek(details.seekTime)
      }
    })
  },

  updateMediaSession: (song: Song) => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession) return
    if (typeof MediaMetadata === 'undefined') return

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album,
      })

      navigator.mediaSession.setPositionState?.({
        duration: song.duration,
        position: 0,
      })
    } catch (e) {
      handleError(e, '更新MediaSession')
    }
  },

  restoreLastSong: async () => {
    // 记录恢复开始时的 opId，用于检测用户是否在恢复期间已开始播放
    const initialOpId = playOperationId
    const isStillInitial = () => playOperationId === initialOpId

    const queueStore = usePlayQueueStore.getState()
    const { lastSongPath, queueSource } = queueStore

    if (!lastSongPath) {
      // 前端无记录，尝试后端兜底（play_counts.last_played）
      try {
        const lastSong = await api.getLastPlayedSong()
        if (!isStillInitial()) return  // 用户已开始播放，放弃恢复
        if (lastSong) {
          const songs = await api.getSongs()
          if (!isStillInitial()) return  // 用户已开始播放，放弃恢复
          const songIndex = songs.findIndex((s) => s.path === lastSong.path)
          if (songIndex >= 0) {
            queueStore.setQueue(songs, songIndex, 'local')
            set({ currentSong: songs[songIndex], currentTime: 0, duration: songs[songIndex].duration, isPlaying: false })
            get().updateMediaSession(songs[songIndex])
            log('后端兜底恢复歌曲', songs[songIndex].title)
          }
        } else {
          log('无上次播放记录', '前后端均无记录')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '后端兜底恢复失败'
        log('后端兜底恢复失败', message)
      }
      return
    }

    try {
      let songs: Song[]
      let source: QueueSource

      if (queueSource === 'liked') {
        const { songs: likedSongs } = await api.getLikedSongs()
        songs = likedSongs
        source = 'liked'
      } else if (queueSource === 'hidden') {
        const [allSongs, hiddenPaths] = await Promise.all([
          api.getSongs(),
          api.getHiddenPaths(),
        ])
        const hiddenSet = new Set(hiddenPaths)
        songs = allSongs.filter((s) => hiddenSet.has(s.path))
        source = 'hidden'
      } else {
        songs = await api.getSongs()
        source = 'local'
      }

      if (!isStillInitial()) return  // 用户已开始播放，放弃恢复

      const songIndex = songs.findIndex((s) => s.path === lastSongPath)
      if (songIndex >= 0) {
        const song = songs[songIndex]
        queueStore.setQueue(songs, songIndex, source)
        set({ currentSong: song, currentTime: 0, duration: song.duration, isPlaying: false })
        get().updateMediaSession(song)
        log('恢复歌曲(仅本地状态)', song.title)
      } else {
        log('上次歌曲未找到', '仅恢复本地状态')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复上次歌曲失败'
      log('恢复上次歌曲失败', message)
    }
  },

  playRandomSong: async () => {
    const queueStore = usePlayQueueStore.getState()
    const { queueSource } = queueStore
    let songs: Song[] = []
    let source: QueueSource = 'local'

    if (queueSource === 'liked') {
      try {
        // 防御性解构：API 返回意外 null/undefined 时不崩溃，回退到空数组
        const likedSongs = (await api.getLikedSongs())?.songs ?? []
        if (likedSongs.length > 0) {
          songs = likedSongs
          source = 'liked'
        }
      } catch (e) {
        handleError(e, '加载喜欢列表')
      }
    }

    if (songs.length === 0 && queueSource === 'hidden') {
      try {
        const [allSongs, hiddenPaths] = await Promise.all([
          api.getSongs(),
          api.getHiddenPaths(),
        ])
        const hiddenSet = new Set(hiddenPaths)
        songs = allSongs.filter((s) => hiddenSet.has(s.path))
        if (songs.length > 0) source = 'hidden'
      } catch (e) {
        handleError(e, '加载隐藏歌曲列表')
      }
    }

    if (songs.length === 0) {
      try {
        songs = await api.getSongs()
        source = 'local'
      } catch (e) {
        handleError(e, '加载歌曲列表')
        return
      }
    }

    if (songs.length === 0) {
      toast('暂无歌曲，请先扫描音乐文件夹')
      return
    }

    const randomIndex = Math.floor(Math.random() * songs.length)
    const song = songs[randomIndex]

    queueStore.setQueue(songs, randomIndex, source)
    await playSongInternal(song, '随机播放')
  },

  initEventListeners: () => {
    if (eventListenersInitialized) return
    eventListenersInitialized = true

    const unsubProgress = listen<PlaybackProgressEvent>('playback_progress', (event) => {
      const { position, duration } = event.payload
      const store = usePlayerStore.getState()

      if (store.isPlaying && store.currentSong) {
        const now = performance.now()
        const gap = Math.abs(position - store.currentTime)
        // rAF 是主要进度来源，后端仅作漂移校准：
        // - gap > 0.3s：偏差过大，强制同步
        // - 每 3s 定期校准一次，防止 rAF 累积漂移
        const shouldSync = gap > 0.3 || now - lastBackendSyncTime > 3000

        if (shouldSync) {
          lastUpdateTime = now
          lastBackendSyncTime = now
          if (duration > 0) {
            set({ currentTime: position, duration })
          } else {
            set({ currentTime: position })
          }
        } else if (duration > 0 && duration !== store.duration) {
          set({ duration })
        }
      }
    })
    eventUnlistenPromises.push(unsubProgress)

    const unsubFinished = listen('track_finished', async () => {
      const pathToFinish = usePlayerStore.getState().currentSong?.path
      // 捕获 await 前的 opId，await 后若变化说明用户已主动切歌，放弃自动推进
      const playOpIdBeforeAwait = playOperationId
      log('歌曲播放完成')
      stopProgressTimer()
      // 立即标记为非播放状态：后端已重置 state，前端需同步，
      // 避免 playNext 失败/队列空时 UI 残留"播放中"
      set({ isPlaying: false })
      await finalizePlayHistory(true)
      // 仅当当前歌曲未在 finalize 期间被用户主动切换时才自动推进
      const curPath = usePlayerStore.getState().currentSong?.path
      if (curPath === pathToFinish && playOpIdBeforeAwait === playOperationId) {
        ++playOperationId
        usePlayerStore.getState().playNext()
      }
    })
    eventUnlistenPromises.push(unsubFinished)

    // 监听音频输出流故障，同步前端状态
    const unsubError = listen('playback_error', () => {
      log('音频输出流故障，重置播放状态')
      stopProgressTimer()
      backendLoaded = false
      // 记录出错歌曲的播放历史并重置 currentPlayPath/accumulatedPlayedMs，
      // 避免残留时长污染下一首的历史记录
      void finalizePlayHistory(false)
      // 重置 currentSong 避免播放失败后 UI 残留失败歌曲，
      // 防止用户点击播放重复触发同一首歌的失败循环
      set({ isPlaying: false, currentTime: 0, currentSong: null, duration: 0 })
    })
    eventUnlistenPromises.push(unsubError)

    log('事件监听器初始化完成')
  },

  cleanupEventListeners: () => {
    eventUnlistenPromises.forEach((p) => {
      p.then((fn) => fn()).catch(() => {})
    })
    eventUnlistenPromises = []
    eventListenersInitialized = false

    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }

    // 清理 mediaSession action handlers，避免销毁后仍持有 store 引用
    if ('mediaSession' in navigator && navigator.mediaSession) {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }

    log('事件监听器已清理')
  },

  destroy: () => {
    // 销毁前尝试保存播放历史（fire-and-forget，HMR/app关闭时无法 await）
    // finalizePlayHistory 内部已捕获 path/elapsed 快照，即使 currentPlayPath 随后被重置也能正确记录
    finalizePlayHistory(false)
    // flush 待发送的音量到后端，避免 destroy 时丢失最后一次调节
    debouncedSetVolume.flush()
    resetModuleState()
    set({
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    log('播放器已销毁')
  },
}))

// Vite HMR 热更新时重置模块级状态，避免旧状态泄漏
if ((import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    resetModuleState()
  })
}
