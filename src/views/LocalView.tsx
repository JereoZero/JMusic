import { useMemo, useCallback } from 'react'
import { useShallow } from 'zustand/shallow'
import { Music } from 'lucide-react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import SongList from '../components/SongList'
import ViewHeader from '../components/ViewHeader'
import { useDebouncedValue, useSongSort, usePersistedSearch } from '../hooks'
import { filterSongs } from '../utils/songUtils'
import type { Song } from '../types'

export default function LocalView() {
  const {
    songs,
    isLoading,
    refreshAll,
    likedPaths,
    hiddenPaths,
    toggleLike,
    toggleHidden,
    batchToggleLike,
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
      batchToggleLike: s.batchToggleLike,
      batchToggleHidden: s.batchToggleHidden,
    }))
  )
  const currentSongPath = usePlayerStore((s) => s.currentSong?.path) ?? null
  const playSong = usePlayerStore((s) => s.playSong)
  const [searchInput, setSearchInput] = usePersistedSearch('local')

  const searchQuery = useDebouncedValue(searchInput, 300)

  const visibleSongs = useMemo(
    () => songs.filter((s) => !hiddenPaths.has(s.path)),
    [songs, hiddenPaths]
  )
  const filteredSongs = useMemo(
    () => filterSongs(visibleSongs, searchQuery),
    [visibleSongs, searchQuery]
  )

  const {
    sortedItems: filteredAndSortedSongs,
    titleSort,
    albumSort,
    handleTitleSort,
    handleAlbumSort,
  } = useSongSort(filteredSongs, likedPaths, 'local')

  const handlePlaySong = useCallback(
    (song: Song) => playSong(song, filteredAndSortedSongs, 'local'),
    [playSong, filteredAndSortedSongs]
  )

  return (
    <div className="h-full flex flex-col select-none">
      <ViewHeader
        title="本地"
        count={filteredAndSortedSongs.length}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onRefresh={refreshAll}
        isLoading={isLoading}
      />
      <SongList
        songs={filteredAndSortedSongs}
        currentSongPath={currentSongPath}
        likedPaths={likedPaths}
        hiddenPaths={hiddenPaths}
        onPlay={handlePlaySong}
        onToggleLike={toggleLike}
        onToggleHidden={toggleHidden}
        onBatchLike={batchToggleLike}
        onBatchHide={batchToggleHidden}
        showHeader
        onTitleSort={handleTitleSort}
        onAlbumSort={handleAlbumSort}
        titleSort={titleSort}
        albumSort={albumSort}
        emptyIcon={<Music size={48} className="mb-4 opacity-50" />}
        emptyTitle="暂无歌曲"
        emptyDescription="请添加音乐文件夹"
        isLoading={isLoading}
        source="local"
      />
    </div>
  )
}
