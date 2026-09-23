import { useEffect, useState, useSyncExternalStore } from 'react'
import { LRUCache } from 'lru-cache'
import api from '../api'
import { APP_CONFIG } from '../config'

/**
 * 封面尺寸档位。
 *
 * 后端有两套缩略图：56px（`get_song_cover` / `get_song_covers_batch`）和
 * 200px（`get_song_cover_large`）。列表行内图标只有 40×40，用 200px 的图会多传
 * 4-8 倍数据、多解码 12.7 倍像素。
 */
export type CoverSize = 'small' | 'large'

/**
 * 封面缓存。**同一个 LRU 同时服务两种尺寸**，因此键必须带尺寸前缀
 * （见 [`coverCacheKey`]）——否则播放器背景（large）与列表行内（small）会互相覆盖：
 * 要么播放器拿到模糊的小图，要么列表白白持有大图。
 */
const coverCache = new LRUCache<string, string>({
  max: APP_CONFIG.player.coverCacheSize,
  ttl: APP_CONFIG.player.coverCacheTTL,
})

/** 拼接带尺寸的缓存键。所有读写缓存的入口都必须经过它。 */
export function coverCacheKey(path: string, size: CoverSize): string {
  return `${size}:${path}`
}

export function getCachedCover(path: string, size: CoverSize): string | undefined {
  return coverCache.get(coverCacheKey(path, size))
}

export function setCachedCover(path: string, size: CoverSize, data: string): void {
  coverCache.set(coverCacheKey(path, size), data)
  // 通知所有订阅者重新读取缓存 —— 批量预取写入后，已挂载的列表项据此自动显示封面
  notifyCoverSubscribers()
}

/** 清空封面缓存（扫描 / 换曲库后调用），并通知订阅者刷新 */
export function clearCoverCache(): void {
  coverCache.clear()
  notifyCoverSubscribers()
}

// ---- 缓存变更通知（供 useSyncExternalStore 订阅）----
const coverSubscribers = new Set<() => void>()

function notifyCoverSubscribers() {
  for (const cb of coverSubscribers) cb()
}

function subscribeCoverCache(cb: () => void): () => void {
  coverSubscribers.add(cb)
  return () => {
    coverSubscribers.delete(cb)
  }
}

/** in-flight 请求去重，键同样带尺寸（不同尺寸是不同的请求，不能互相复用结果） */
const pendingRequests = new Map<string, Promise<string | null>>()

/**
 * 返回指定 path+size 的 in-flight 请求（若有）。
 * 供 coverStore 与批量预取复用，避免同一张图被重复请求。
 */
export function getPendingCoverRequest(
  path: string,
  size: CoverSize = 'small'
): Promise<string | null> | null {
  return pendingRequests.get(coverCacheKey(path, size)) ?? null
}

/** 登记一个 in-flight 请求（带自动清理），返回该请求 */
function trackPendingRequest(path: string, size: CoverSize, promise: Promise<string | null>) {
  const key = coverCacheKey(path, size)
  pendingRequests.set(key, promise)
  void promise.finally(() => {
    // 只有仍是自己时才删除，避免覆盖后误删新请求
    if (pendingRequests.get(key) === promise) pendingRequests.delete(key)
  })
}

/** 发起单张封面请求（尺寸对应不同后端命令），成功即写缓存 */
function requestCover(path: string, size: CoverSize): Promise<string | null> {
  const key = coverCacheKey(path, size)
  const existing = pendingRequests.get(key)
  if (existing) return existing

  const promise = (size === 'small' ? api.getSongCover(path) : api.getSongCoverLarge(path))
    .then((cover) => {
      if (cover) setCachedCover(path, size, cover)
      return cover
    })
    .catch((e) => {
      console.error('Failed to load song cover:', path, e)
      return null
    })

  trackPendingRequest(path, size, promise)
  return promise
}

/** 后端批量接口的单次上限，与 `MAX_BATCH_SIZE` 保持一致 */
const COVER_BATCH_SIZE = 100

/** 预取调度的合并窗口：滚动过程中最多每 60ms 发一次批量请求 */
const PREFETCH_DEBOUNCE_MS = 60

let prefetchTimer: ReturnType<typeof setTimeout> | null = null
const prefetchQueue = new Set<string>()

/**
 * 批量预取小缩略图（列表滚动时调用）。
 *
 * 逐行各自请求会为每一行发一次 IPC；这里把短时间内的可见行合并成一次
 * `get_song_covers_batch`，把「每屏 N 次往返」降到「1 次」。
 *
 * 已在缓存中、或已有 in-flight 请求的路径会被跳过 —— 因此 `SongItem` 里
 * 各自的单张请求也不会与预取重复发同一个文件。
 */
export function prefetchCovers(paths: string[]): void {
  for (const path of paths) {
    if (!path) continue
    if (coverCache.has(coverCacheKey(path, 'small'))) continue
    if (pendingRequests.has(coverCacheKey(path, 'small'))) continue
    prefetchQueue.add(path)
  }

  if (prefetchQueue.size === 0 || prefetchTimer) return

  prefetchTimer = setTimeout(() => {
    prefetchTimer = null
    const batch = Array.from(prefetchQueue)
    prefetchQueue.clear()
    for (let i = 0; i < batch.length; i += COVER_BATCH_SIZE) {
      void fetchCoverBatch(batch.slice(i, i + COVER_BATCH_SIZE))
    }
  }, PREFETCH_DEBOUNCE_MS)
}

async function fetchCoverBatch(paths: string[]): Promise<void> {
  if (paths.length === 0) return

  // 先占位 pending：让这期间 SongItem 的单张请求直接复用这次批量结果，
  // 而不是各自再发一次 IPC
  const batchPromise = api
    .getSongCoversBatch(paths)
    .then((covers) => {
      for (const [path, cover] of Object.entries(covers)) {
        setCachedCover(path, 'small', cover)
      }
      return null
    })
    .catch((e) => {
      console.error('Failed to prefetch song covers:', e)
      return null
    })

  for (const path of paths) {
    trackPendingRequest(path, 'small', batchPromise)
  }

  await batchPromise
}

/**
 * 订阅某首歌的封面（默认 56px 小图，供列表行内使用）。
 *
 * 用 `useSyncExternalStore` 订阅缓存：批量预取写入缓存后，已经挂载的行会自动
 * 重新读取并显示封面 —— 不需要"预取完成事件"这类广播机制。
 * 由于 snapshot 是「该 path 的缓存值」，缓存中其他 path 变化不会让本行重渲染。
 *
 * 播放器大图/背景请走 `coverStore`（它请求 200px 并做取色）。
 */
export function useSongCover(path: string | undefined, size: CoverSize = 'small') {
  const cover = useSyncExternalStore(subscribeCoverCache, () =>
    path ? getCachedCover(path, size) : undefined
  )
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!path) {
      setIsLoading(false)
      return
    }
    // 已缓存：无需请求（也不显示 loading）
    if (getCachedCover(path, size)) {
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    void requestCover(path, size).finally(() => {
      if (!cancelled) setIsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [path, size])

  return { cover: cover ?? null, isLoading }
}
