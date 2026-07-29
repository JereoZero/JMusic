import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { Music } from 'lucide-react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import api from '../api'
import type { PlayHistory } from '../api'
import type { Song } from '../types'
import { APP_CONFIG } from '../config'
import { playHistoryToSong } from '../utils/adapters'
import { filterByQuery } from '../utils/songUtils'
import SongList from '../components/SongList'
import ViewHeader from '../components/ViewHeader'
import { useSongSort, useDebouncedValue, usePersistedSearch } from '../hooks'
import { handleError } from '../utils/errorHandler'

export default function HistoryView() {
  const [playHistory, setPlayHistory] = useState<PlayHistory[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchInput, setSearchInput] = usePersistedSearch('history')
  const searchQuery = useDebouncedValue(searchInput, 300)
  const loadOpIdRef = useRef(0)

  const currentSongPath = usePlayerStore((s) => s.currentSong?.path) ?? null
  const playSong = usePlayerStore((s) => s.playSong)
  const { likedPaths, hiddenPaths, toggleLike, toggleHidden, batchToggleLike, batchToggleHidden } =
    useLibraryStore(
      useShallow((s) => ({
        likedPaths: s.likedPaths,
        hiddenPaths: s.hiddenPaths,
        toggleLike: s.toggleLike,
        toggleHidden: s.toggleHidden,
        batchToggleLike: s.batchToggleLike,
        batchToggleHidden: s.batchToggleHidden,
      }))
    )

  // 统一的加载函数，带竞态保护（防止快速刷新或卸载后 setState）
  const loadPlayHistory = useCallback(async () => {
    const opId = ++loadOpIdRef.current
    setIsLoading(true)
    try {
      const data = await api.getPlayHistory(APP_CONFIG.ui.historyFetchLimit)
      if (opId !== loadOpIdRef.current) return
      setPlayHistory(data)
    } catch (error) {
      if (opId !== loadOpIdRef.current) return
      handleError(error, '加载播放历史')
    } finally {
      if (opId === loadOpIdRef.current) setIsLoading(false)
    }
  }, [])

  // M12 修复：切歌后刷新历史用 3s 防抖，避免快速切歌（按 next 5 次）触发 5 次 API
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    loadPlayHistory()
    // 卸载时递增 opId，使进行中的请求 opId 不再匹配，跳过 setState
    return () => {
      loadOpIdRef.current++
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [loadPlayHistory])

  // 播放新歌后自动刷新历史（3s 防抖：快速切歌只刷新一次）
  useEffect(() => {
    if (!currentSongPath) return
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      loadPlayHistory()
    }, 3000)
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [currentSongPath, loadPlayHistory])
  /* eslint-enable react-hooks/exhaustive-deps */

  const filteredHistory = useMemo(() => {
    const visibleHistory = playHistory.filter((item) => !hiddenPaths.has(item.path))
    return filterByQuery(visibleHistory, searchQuery).map(playHistoryToSong)
  }, [playHistory, searchQuery, hiddenPaths])

  const {
    sortedItems: filteredAndSortedSongs,
    titleSort,
    albumSort,
    handleTitleSort,
    handleAlbumSort,
  } = useSongSort(filteredHistory, undefined, 'history')

  const handlePlayFromHistory = useCallback(
    (song: Song) => {
      playSong(song, filteredAndSortedSongs, 'history')
    },
    [playSong, filteredAndSortedSongs]
  )

  return (
    <div className="h-full flex flex-col select-none">
      <ViewHeader
        title="播放历史"
        count={filteredAndSortedSongs.length}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onRefresh={loadPlayHistory}
        isLoading={isLoading}
      />

      <SongList
        songs={filteredAndSortedSongs}
        currentSongPath={currentSongPath}
        likedPaths={likedPaths}
        hiddenPaths={hiddenPaths}
        onPlay={handlePlayFromHistory}
        onToggleLike={toggleLike}
        onToggleHidden={toggleHidden}
        onBatchLike={batchToggleLike}
        onBatchHide={batchToggleHidden}
        showLikeButton={false}
        showHeader
        onTitleSort={handleTitleSort}
        onAlbumSort={handleAlbumSort}
        titleSort={titleSort}
        albumSort={albumSort}
        emptyIcon={<Music size={48} className="mb-4 opacity-50" />}
        emptyTitle="暂无播放历史"
        emptyDescription="播放歌曲后会自动记录"
        isLoading={isLoading}
      />
    </div>
  )
}
