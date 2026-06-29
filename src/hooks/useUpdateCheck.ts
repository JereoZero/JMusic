import { useState, useCallback, useRef, useEffect } from 'react'
import { compareVersions } from 'compare-versions'
import { APP_CONFIG } from '../config'

interface UpdateInfo {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
}

// localStorage 缓存：5 分钟内复用，避免频繁请求 GitHub API 触发 60次/小时限流
const CACHE_KEY = 'jlocal-update-check'
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

interface CachedUpdateInfo extends UpdateInfo {
  cachedAt: number
}

function getCachedUpdateInfo(): UpdateInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedUpdateInfo
    if (Date.now() - cached.cachedAt > CACHE_TTL) return null
    // 返回时剥离 cachedAt 字段
    return {
      hasUpdate: cached.hasUpdate,
      latestVersion: cached.latestVersion,
      currentVersion: cached.currentVersion,
      releaseUrl: cached.releaseUrl,
      releaseNotes: cached.releaseNotes,
      publishedAt: cached.publishedAt,
    }
  } catch {
    return null
  }
}

function setCachedUpdateInfo(info: UpdateInfo) {
  try {
    const cached: CachedUpdateInfo = { ...info, cachedAt: Date.now() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export function useUpdateCheck() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const checkUpdate = useCallback(async (force = false) => {
    // 非强制刷新时先检查缓存
    if (!force) {
      const cached = getCachedUpdateInfo()
      if (cached) {
        setUpdateInfo(cached)
        return cached.hasUpdate
      }
    }

    // 取消上一次未完成的请求，避免竞态
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsChecking(true)
    setError(null)

    try {
      const response = await fetch(
        `https://api.github.com/repos/JereoZero/JMusic/releases/latest`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
          },
          signal: controller.signal,
        }
      )

      if (!response.ok) {
        throw new Error(`GitHub API 错误: ${response.status}`)
      }

      const data = await response.json()
      const latestVersion = data.tag_name?.replace(/^v/, '') || ''
      const currentVersion = APP_CONFIG.version

      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

      const info: UpdateInfo = {
        hasUpdate,
        latestVersion,
        currentVersion,
        releaseUrl: data.html_url || APP_CONFIG.releasesUrl,
        releaseNotes: data.body || '',
        publishedAt: data.published_at || '',
      }

      setUpdateInfo(info)
      setCachedUpdateInfo(info)

      return hasUpdate
    } catch (err) {
      // AbortError 是主动取消，不作为错误处理
      if (err instanceof Error && err.name === 'AbortError') return false
      const message = err instanceof Error ? err.message : '检查更新失败'
      setError(message)
      return false
    } finally {
      if (!controller.signal.aborted) {
        setIsChecking(false)
      }
    }
  }, [])

  // 组件卸载时取消进行中的 fetch，防止 setState 已卸载组件
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const clearUpdateInfo = useCallback(() => {
    setUpdateInfo(null)
    setError(null)
  }, [])

  return {
    updateInfo,
    isChecking,
    error,
    checkUpdate,
    clearUpdateInfo,
  }
}
