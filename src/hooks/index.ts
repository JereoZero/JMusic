import { useState, useEffect, useMemo } from 'react'
import { debounce } from 'es-toolkit'

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  // 仅 delay 变化时重建 debounce 实例，避免每次 value 变化都创建新对象
  const debouncedSet = useMemo(() => debounce(setDebouncedValue, delay), [delay])

  useEffect(() => {
    debouncedSet(value)
    return () => debouncedSet.cancel()
  }, [value, debouncedSet])

  return debouncedValue
}

/**
 * 按视图 key 持久化搜索词到 sessionStorage，切换视图再切回时搜索词不丢失。
 * 与 useSongSort 的持久化策略对齐。
 */
export function usePersistedSearch(viewKey: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(`search:${viewKey}`) ?? ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(`search:${viewKey}`, value)
    } catch {
      // sessionStorage 不可用时静默降级
    }
  }, [viewKey, value])

  return [value, setValue]
}

export { useSongCover } from './useSongCover'
export { useSongSort, getSortIcon } from './useSongSort'
export type { TitleSortType, AlbumSortType, LikeSortType } from './useSongSort'
export { useUpdateCheck } from './useUpdateCheck'
export { useScanProgress } from './useScanProgress'
