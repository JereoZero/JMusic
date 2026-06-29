import { useState, useEffect, useRef } from 'react'
import { LRUCache } from 'lru-cache'
import api from '../api'
import { APP_CONFIG } from '../config'

// 导出 coverCache 供 coverStore 复用，避免缓存不一致
export const coverCache = new LRUCache<string, string>({
  max: APP_CONFIG.player.coverCacheSize,
  ttl: APP_CONFIG.player.coverCacheTTL,
})

const pendingRequests = new Map<string, Promise<string | null>>()

const PENDING_REQUEST_TTL = 30_000

/**
 * #10 修复：返回指定 path 的 in-flight 封面请求（若有）。
 * 供 coverStore 复用，避免同一 path 双倍请求。
 */
export function getPendingCoverRequest(path: string): Promise<string | null> | null {
  return pendingRequests.get(path) ?? null
}

// 用 setTimeout 链式清理替代 setInterval，HMR 时不会累积泄漏
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
function schedulePendingCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null
    // 先检查再清理：若有残留请求则清空并重新调度，否则停止定时器
    if (pendingRequests.size > 0) {
      pendingRequests.clear()
      schedulePendingCleanup()
    }
  }, PENDING_REQUEST_TTL)
}

export function useSongCover(path: string | undefined) {
  const [cover, setCover] = useState<string | null>(() => {
    if (!path) return null
    return coverCache.get(path) || null
  })
  const [isLoading, setIsLoading] = useState(false)
  const currentPathRef = useRef<string | undefined>(path)

  useEffect(() => {
    currentPathRef.current = path

    if (!path) {
      setCover(null)
      setIsLoading(false)
      return
    }

    const cachedCover = coverCache.get(path)
    if (cachedCover) {
      setCover(cachedCover)
      setIsLoading(false)
      return
    }

    setCover(null)
    setIsLoading(true)

    if (pendingRequests.has(path)) {
      let cancelled = false
      pendingRequests.get(path)?.then((coverData) => {
        if (!cancelled && currentPathRef.current === path) {
          setCover(coverData)
          setIsLoading(false)
        }
      })
      return () => { cancelled = true }
    }

    let cancelled = false
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(path)
    }, PENDING_REQUEST_TTL)

    const promise = api
      .getSongCoverLarge(path)
      .then((coverData) => {
        if (coverData) {
          coverCache.set(path, coverData)
        }
        if (!cancelled && currentPathRef.current === path) {
          setCover(coverData)
        }
        return coverData
      })
      .catch((e) => {
        console.error('Failed to load song cover:', path, e)
        if (!cancelled && currentPathRef.current === path) {
          setCover(null)
        }
        return null
      })
      .finally(() => {
        clearTimeout(timeoutId)
        pendingRequests.delete(path)
        if (!cancelled && currentPathRef.current === path) {
          setIsLoading(false)
        }
      })

    pendingRequests.set(path, promise)
    schedulePendingCleanup()
    return () => { cancelled = true }
  }, [path])

  return { cover, isLoading }
}

export function clearCoverCache() {
  coverCache.clear()
}

export function getCoverCacheSize() {
  return coverCache.size
}

// Vite HMR 热更新时清理模块级定时器与待处理请求，避免旧模块的 setTimeout 残留
if ((import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
    pendingRequests.clear()
  })
}
