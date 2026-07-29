import { useState, useMemo, useCallback } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import React from 'react'

export type TitleSortType = 'default' | 'title-asc' | 'title-desc' | 'artist-asc' | 'artist-desc'
export type AlbumSortType = 'default' | 'album-asc' | 'album-desc'
export type LikeSortType = 'default' | 'liked-first' | 'unliked-first'

interface SortableItem {
  title?: string
  artist?: string
  album?: string
  path: string
}

const SORT_KEY = 'jlocal_sort_'

// 合法排序值白名单，用于校验 sessionStorage 读取的值
const VALID_SORTS = new Set([
  'default',
  'title-asc',
  'title-desc',
  'artist-asc',
  'artist-desc',
  'album-asc',
  'album-desc',
  'liked-first',
  'unliked-first',
])

function readStoredSort<T extends string>(key: string, fallback: T): T {
  try {
    const stored = sessionStorage.getItem(SORT_KEY + key)
    if (stored && VALID_SORTS.has(stored)) return stored as T
    return fallback
  } catch {
    return fallback
  }
}

function writeStoredSort(key: string, value: string) {
  try {
    sessionStorage.setItem(SORT_KEY + key, value)
  } catch {
    /* noop */
  }
}

export function getSortIcon(sortType: string): React.ReactNode {
  if (sortType === 'default')
    return React.createElement(ArrowUpDown, { size: 14, className: 'opacity-30' })
  if (sortType.includes('asc')) return React.createElement(ArrowUp, { size: 14 })
  return React.createElement(ArrowDown, { size: 14 })
}

export function useSongSort<T extends SortableItem>(
  items: T[],
  likedPaths?: Set<string>,
  viewKey?: string
) {
  const [titleSort, setTitleSortState] = useState<TitleSortType>(() =>
    viewKey ? readStoredSort(`${viewKey}_title`, 'default') : 'default'
  )
  const [albumSort, setAlbumSortState] = useState<AlbumSortType>(() =>
    viewKey ? readStoredSort(`${viewKey}_album`, 'default') : 'default'
  )
  const [likeSort, setLikeSortState] = useState<LikeSortType>(() =>
    viewKey ? readStoredSort(`${viewKey}_like`, 'default') : 'default'
  )

  const persistSort = useCallback(
    (key: string, value: string) => {
      if (viewKey) writeStoredSort(`${viewKey}_${key}`, value)
    },
    [viewKey]
  )

  const setTitleSort = useCallback(
    (value: TitleSortType) => {
      setTitleSortState(value)
      persistSort('title', value)
    },
    [persistSort]
  )

  const setAlbumSort = useCallback(
    (value: AlbumSortType) => {
      setAlbumSortState(value)
      persistSort('album', value)
    },
    [persistSort]
  )

  const setLikeSort = useCallback(
    (value: LikeSortType) => {
      setLikeSortState(value)
      persistSort('like', value)
    },
    [persistSort]
  )

  const handleTitleSort = useCallback(() => {
    const order: TitleSortType[] = [
      'default',
      'title-asc',
      'title-desc',
      'artist-asc',
      'artist-desc',
    ]
    const currentIndex = order.indexOf(titleSort)
    const nextSort = order[(currentIndex + 1) % order.length]
    setTitleSort(nextSort)
    setAlbumSort('default')
    setLikeSort('default')
  }, [titleSort, setTitleSort, setAlbumSort, setLikeSort])

  const handleAlbumSort = useCallback(() => {
    const order: AlbumSortType[] = ['default', 'album-asc', 'album-desc']
    const currentIndex = order.indexOf(albumSort)
    const nextSort = order[(currentIndex + 1) % order.length]
    setAlbumSort(nextSort)
    setTitleSort('default')
    setLikeSort('default')
  }, [albumSort, setAlbumSort, setTitleSort, setLikeSort])

  const handleLikeSort = useCallback(() => {
    const order: LikeSortType[] = ['default', 'liked-first', 'unliked-first']
    const currentIndex = order.indexOf(likeSort)
    const nextSort = order[(currentIndex + 1) % order.length]
    setLikeSort(nextSort)
    setTitleSort('default')
    setAlbumSort('default')
  }, [likeSort, setLikeSort, setTitleSort, setAlbumSort])

  const sortedItems = useMemo(() => {
    const result = [...items]

    if (likeSort !== 'default' && likedPaths) {
      result.sort((a, b) => {
        const aLiked = likedPaths.has(a.path) ? 1 : 0
        const bLiked = likedPaths.has(b.path) ? 1 : 0
        return likeSort === 'liked-first' ? bLiked - aLiked : aLiked - bLiked
      })
    }

    if (albumSort !== 'default') {
      result.sort((a, b) => {
        const albumA = (a.album || '').toLowerCase()
        const albumB = (b.album || '').toLowerCase()
        return albumSort === 'album-asc'
          ? albumA.localeCompare(albumB)
          : albumB.localeCompare(albumA)
      })
    } else if (titleSort !== 'default') {
      switch (titleSort) {
        case 'title-asc':
          result.sort((a, b) =>
            (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
          )
          break
        case 'title-desc':
          result.sort((a, b) =>
            (b.title || '').toLowerCase().localeCompare((a.title || '').toLowerCase())
          )
          break
        case 'artist-asc':
          result.sort((a, b) =>
            (a.artist || '').toLowerCase().localeCompare((b.artist || '').toLowerCase())
          )
          break
        case 'artist-desc':
          result.sort((a, b) =>
            (b.artist || '').toLowerCase().localeCompare((a.artist || '').toLowerCase())
          )
          break
      }
    }

    return result
  }, [items, titleSort, albumSort, likeSort, likedPaths])

  return {
    sortedItems,
    titleSort,
    albumSort,
    likeSort,
    handleTitleSort,
    handleAlbumSort,
    handleLikeSort,
    getSortIcon,
  }
}
