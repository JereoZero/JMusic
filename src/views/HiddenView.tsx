import { useMemo, useCallback } from 'react'
import { useShallow } from 'zustand/shallow'
import { EyeOff } from 'lucide-react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import SongList from '../components/SongList'
import ViewHeader from '../components/ViewHeader'
import { useDebouncedValue, useSongSort, usePersistedSearch } from '../hooks'
import { filterSongs } from '../utils/songUtils'
import type { Song } from '../types'

export default function HiddenView() {
  const [searchInput, setSearchInput] = usePersistedSearch('hidden')
  const searchQuery = useDebouncedValue(searchInput, 300)

  const currentSongPath = usePlayerStore((s) => s.currentSong?.path) ?? null
  const playSong = usePlayerStore((s) => s.playSong)
  const {
    songs,
    isLoading,
    refreshAll,
    likedPaths,
    hiddenPaths,
    toggleLike,
    toggleHidden,
    batchToggleHidden,
  } = useLibraryStore(
    useShallow((s) => ({
      songs: s.songs,
      isLoading: s.isLoading,
      likedPaths: s.likedPaths,
      hiddenPaths: s.hiddenPaths,
      refreshAll: s.refreshAll,
      toggleLike: s.toggleLike,
      toggleHidden: s.toggleHidden,
      batchToggleHidden: s.batchToggleHidden,
    }))
  )

  const hiddenSongs = useMemo(() => {
    return songs.filter((song) => hiddenPaths.has(song.path))
  }, [songs, hiddenPaths])

  const filteredSongs = useMemo(() => {
    return filterSongs(hiddenSongs, searchQuery)
  }, [hiddenSongs, searchQuery])

  const {
    sortedItems: filteredAndSortedSongs,
    titleSort,
    albumSort,
    handleTitleSort,
    handleAlbumSort,
  } = useSongSort(filteredSongs, undefined, 'hidden')

  const handlePlaySong = useCallback(
    (song: Song) => {
      playSong(song, filteredAndSortedSongs, 'hidden')
    },
    [playSong, filteredAndSortedSongs]
  )

  // 稳定引用，避免破坏 SongItem 的 memo
  const handleToggleLike = useCallback((path: string) => toggleLike(path, 'hidden'), [toggleLike])

  return (
    <div className="h-full flex flex-col select-none">
      <ViewHeader
        title="已隐藏"
        count={filteredAndSortedSongs.length}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onRefresh={refreshAll}
        isLoading={isLoading}
      />

      <div className="px-6 py-3 border-b border-white/5 bg-white/5">
        <p className="text-sm text-zinc-400">
          隐藏的歌曲不会显示在本地音乐列表中。点击取消隐藏按钮可将歌曲移回本地音乐。
        </p>
      </div>

      <SongList
        songs={filteredAndSortedSongs}
        currentSongPath={currentSongPath}
        likedPaths={likedPaths}
        hiddenPaths={hiddenPaths}
        onPlay={handlePlaySong}
        onToggleLike={handleToggleLike}
        onToggleHidden={toggleHidden}
        onBatchHide={batchToggleHidden}
        showLikeButton={false}
        showHiddenButton
        showHeader
        onTitleSort={handleTitleSort}
        onAlbumSort={handleAlbumSort}
        titleSort={titleSort}
        albumSort={albumSort}
        emptyIcon={<EyeOff size={48} className="mb-4 opacity-50" />}
        emptyTitle="暂无隐藏的歌曲"
        emptyDescription="在本地音乐中点击隐藏按钮可将歌曲移到这里"
        isLoading={isLoading}
      />
    </div>
  )
}
