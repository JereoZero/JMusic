import { create } from 'zustand'
import type { Song } from '../types'
import api from '../api'
import { toast } from 'sonner'
import { mutex } from 'async-mutex-lite'
import { useOperationLogStore } from './operationLogStore'
import { clearCoverStoreCache, reloadCurrentCover } from './coverStore'

const log = (action: string, detail?: string, error?: string) => {
  useOperationLogStore.getState().log(action, detail, error)
}

// 并发保护：防止快速多次调用 fetchSongs/refreshAll 导致后返回的响应覆盖先返回的
let fetchOpId = 0
// likedPaths/hiddenPaths 独立 opId，与 fetchOpId 隔离避免互相失效
let fetchLikedOpId = 0
let fetchHiddenOpId = 0

interface LibraryStore {
  songs: Song[]
  likedPaths: Set<string>
  hiddenPaths: Set<string>
  isLoading: boolean
  error: string | null
  fetchSongs: () => Promise<void>
  fetchSongsAfterScan: () => Promise<void>
  fetchLikedPaths: () => Promise<void>
  fetchHiddenPaths: () => Promise<void>
  refreshAll: () => Promise<void>
  toggleLike: (path: string, context?: 'hidden') => Promise<void>
  toggleHidden: (path: string, shouldRemoveLike?: boolean) => Promise<void>
  batchToggleLike: (paths: string[], liked: boolean) => Promise<void>
  batchToggleHidden: (paths: string[], hidden: boolean) => Promise<void>
  clearError: () => void
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  songs: [],
  likedPaths: new Set(),
  hiddenPaths: new Set(),
  // 初始即为加载中：App 启动 useEffect 会立即 fetchSongs，
  // 设为 true 避免首帧 songs=[] && isLoading=false 时 UI 闪现“暂无歌曲”空状态
  isLoading: true,
  error: null,

  clearError: () => set({ error: null }),

  fetchSongs: async () => {
    const opId = ++fetchOpId
    set({ isLoading: true, error: null })
    try {
      const songs = await api.getSongs()
      if (opId !== fetchOpId) return // 有更新的请求发出，丢弃过时结果
      set({ songs })
    } catch (error) {
      if (opId !== fetchOpId) return
      const message = error instanceof Error ? error.message : '获取歌曲失败'
      set({ error: message })
      toast.error(message)
    } finally {
      if (opId === fetchOpId) set({ isLoading: false })
    }
  },

  // 扫描后调用：清除封面缓存（封面可能已变化）再 fetchSongs
  fetchSongsAfterScan: async () => {
    // #3 修复：同时清封面+颜色缓存，并重新加载当前歌曲封面
    clearCoverStoreCache()
    await useLibraryStore.getState().fetchSongs()
    reloadCurrentCover()
  },

  fetchLikedPaths: async () => {
    const opId = ++fetchLikedOpId
    try {
      const paths = await api.getLikedPaths()
      if (opId !== fetchLikedOpId) return
      set({ likedPaths: new Set(paths) })
    } catch (error) {
      if (opId !== fetchLikedOpId) return
      const message = error instanceof Error ? error.message : '获取喜欢列表失败'
      toast.error(message)
    }
  },

  fetchHiddenPaths: async () => {
    const opId = ++fetchHiddenOpId
    try {
      const paths = await api.getHiddenPaths()
      if (opId !== fetchHiddenOpId) return
      set({ hiddenPaths: new Set(paths) })
    } catch (error) {
      if (opId !== fetchHiddenOpId) return
      const message = error instanceof Error ? error.message : '获取隐藏列表失败'
      toast.error(message)
    }
  },

  refreshAll: async () => {
    // 三个独立 opId：避免单个 fetchSongs 调用（共享 fetchOpId）丢弃整个 refreshAll 的 liked/hidden 更新
    const songsOpId = ++fetchOpId
    const likedOpId = ++fetchLikedOpId
    const hiddenOpId = ++fetchHiddenOpId
    set({ isLoading: true, error: null })
    try {
      const [songs, likedPaths, hiddenPaths] = await Promise.all([
        api.getSongs(),
        api.getLikedPaths(),
        api.getHiddenPaths(),
      ])
      // 各自检查 opId，仅更新未被新请求覆盖的部分
      set((state) => ({
        songs: songsOpId === fetchOpId ? songs : state.songs,
        likedPaths: likedOpId === fetchLikedOpId ? new Set(likedPaths) : state.likedPaths,
        hiddenPaths: hiddenOpId === fetchHiddenOpId ? new Set(hiddenPaths) : state.hiddenPaths,
      }))
      toast.success('刷新成功')
    } catch (error) {
      const message = error instanceof Error ? error.message : '刷新失败'
      set({ error: message })
      toast.error(message)
    } finally {
      if (songsOpId === fetchOpId) set({ isLoading: false })
    }
  },

  toggleLike: async (path: string, context?: 'hidden') => {
    // per-path 串行化：避免乐观更新+回滚在交叉执行时基于错误的当前值回滚
    return mutex(path, async () => {
      const { likedPaths, hiddenPaths } = get()
      const newLiked = !likedPaths.has(path)

      log('点击喜欢', `${newLiked ? '添加' : '取消'}: ${path.split('/').pop()}`)

      // 乐观更新：先更新 UI 状态
      const newLikedPaths = new Set(likedPaths)
      if (newLiked) {
        newLikedPaths.add(path)
      } else {
        newLikedPaths.delete(path)
      }
      set({ likedPaths: newLikedPaths })

      try {
        // 如果在隐藏列表中点击喜欢，先取消隐藏
        if (context === 'hidden' && hiddenPaths.has(path) && newLiked) {
          await api.unhideSong(path)
          const newHiddenPaths = new Set(hiddenPaths)
          newHiddenPaths.delete(path)
          set({ hiddenPaths: newHiddenPaths })
          toast.success('已恢复歌曲到本地音乐')
        }

        await api.toggleLike(path, newLiked)
        log('后台执行', `toggleLike(${path}, ${newLiked})`)

        if (newLiked) {
          toast('已添加到喜欢', { icon: '❤️', duration: 2000 })
        } else {
          toast.info('已从喜欢列表移除')
        }
      } catch (error) {
        // 回滚乐观更新：likedPaths
        const rollbackPaths = new Set(get().likedPaths)
        if (newLiked) {
          rollbackPaths.delete(path)
        } else {
          rollbackPaths.add(path)
        }
        set({ likedPaths: rollbackPaths })
        // 回滚 hiddenPaths（若已取消隐藏但 toggleLike 失败）
        if (context === 'hidden' && hiddenPaths.has(path) && newLiked) {
          const rollbackHidden = new Set(get().hiddenPaths)
          rollbackHidden.add(path)
          set({ hiddenPaths: rollbackHidden })
        }
        const message = error instanceof Error ? error.message : '操作失败'
        log('喜欢操作失败', message)
        toast.error(message)
      }
    })
  },

  toggleHidden: async (path: string, shouldRemoveLike: boolean = false) => {
    // per-path 串行化：避免乐观更新+回滚在交叉执行时基于错误的当前值回滚
    return mutex(path, async () => {
      const { hiddenPaths, likedPaths } = get()
      const newHidden = !hiddenPaths.has(path)

      log('点击隐藏', `${newHidden ? '隐藏' : '显示'}: ${path.split('/').pop()}`)

      // 乐观更新：先更新 UI 状态
      const newHiddenPaths = new Set(hiddenPaths)
      if (newHidden) {
        newHiddenPaths.add(path)
      } else {
        newHiddenPaths.delete(path)
      }
      set({ hiddenPaths: newHiddenPaths })

      let likeRemoved = false
      try {
        if (newHidden) {
          await api.hideSong(path)
          log('后台执行', `hideSong(${path})`)

          // 如果需要同时取消喜欢
          if (shouldRemoveLike && likedPaths.has(path)) {
            await api.toggleLike(path, false)
            const newLikedPaths = new Set(get().likedPaths)
            newLikedPaths.delete(path)
            set({ likedPaths: newLikedPaths })
            likeRemoved = true
          }

          toast('已隐藏歌曲', { icon: '🚫', duration: 2000 })
        } else {
          await api.unhideSong(path)
          log('后台执行', `unhideSong(${path})`)
          toast.success('已恢复歌曲')
        }
      } catch (error) {
        // 回滚乐观更新：hiddenPaths
        const rollbackPaths = new Set(get().hiddenPaths)
        if (newHidden) {
          rollbackPaths.delete(path)
        } else {
          rollbackPaths.add(path)
        }
        set({ hiddenPaths: rollbackPaths })
        // 回滚 likedPaths（若已取消喜欢但后续操作失败）
        if (likeRemoved && likedPaths.has(path)) {
          const rollbackLiked = new Set(get().likedPaths)
          rollbackLiked.add(path)
          set({ likedPaths: rollbackLiked })
        }
        const message = error instanceof Error ? error.message : '操作失败'
        log('隐藏操作失败', message)
        toast.error(message)
      }
    })
  },

  batchToggleLike: async (paths, liked) => {
    if (paths.length === 0) return
    log('批量喜欢', `${liked ? '添加' : '取消'} ${paths.length} 首`)
    // 乐观更新
    const newLikedPaths = new Set(get().likedPaths)
    paths.forEach((p) => {
      if (liked) newLikedPaths.add(p)
      else newLikedPaths.delete(p)
    })
    set({ likedPaths: newLikedPaths })

    // H1+M3 修复：用 per-path mutex 串行化避免与单首 toggleLike 竞态；
    // 用 allSettled 等所有请求完成后再决定回滚，避免 in-flight 请求与 fetchLikedPaths 竞态
    const results = await Promise.allSettled(
      paths.map((p) => mutex(p, () => api.toggleLike(p, liked)))
    )
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      await get().fetchLikedPaths()
      log('批量喜欢部分失败', `${failed.length}/${paths.length}`)
      toast.error(`部分失败 ${failed.length}/${paths.length}`)
    } else {
      toast.success(`已${liked ? '添加' : '取消'}喜欢 ${paths.length} 首`)
    }
  },

  batchToggleHidden: async (paths, hidden) => {
    if (paths.length === 0) return
    log('批量隐藏', `${hidden ? '隐藏' : '恢复'} ${paths.length} 首`)
    const newHiddenPaths = new Set(get().hiddenPaths)
    paths.forEach((p) => {
      if (hidden) newHiddenPaths.add(p)
      else newHiddenPaths.delete(p)
    })
    set({ hiddenPaths: newHiddenPaths })

    try {
      if (hidden) {
        await api.hideSongsBatch(paths)
      } else {
        await api.unhideSongsBatch(paths)
      }
      toast.success(`已${hidden ? '隐藏' : '恢复'} ${paths.length} 首`)
    } catch (error) {
      await get().fetchHiddenPaths()
      const message = error instanceof Error ? error.message : '批量操作失败'
      log('批量隐藏失败', message)
      toast.error(message)
    }
  },
}))
