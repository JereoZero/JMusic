import { useMemo, useCallback } from 'react'
import { useShallow } from 'zustand/shallow'
import { Heart, Play } from 'lucide-react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import SongList from '../components/SongList'
import ViewHeader from '../components/ViewHeader'
import { useDebouncedValue, useSongSort, usePersistedSearch } from '../hooks'
import { filterSongs } from '../utils/songUtils'
import { hexToRgba, THEMES } from '../config/themes'
import { useThemeStore } from '../stores/themeStore'
import type { Song } from '../types'

export default function LikedView() {
  const [searchInput, setSearchInput] = usePersistedSearch('liked')
  const searchQuery = useDebouncedValue(searchInput, 300)

  const currentSongPath = usePlayerStore((s) => s.currentSong?.path) ?? null
  const playSong = usePlayerStore((s) => s.playSong)
  const { songs, isLoading, refreshAll, likedPaths, hiddenPaths, toggleLike, toggleHidden, batchToggleLike, batchToggleHidden } =
    useLibraryStore(
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

  const likedSongs = useMemo(() => {
    return songs.filter((song) => likedPaths.has(song.path) && !hiddenPaths.has(song.path))
  }, [songs, likedPaths, hiddenPaths])

  const filteredSongs = useMemo(() => {
    return filterSongs(likedSongs, searchQuery)
  }, [likedSongs, searchQuery])

  const {
    sortedItems: filteredAndSortedSongs,
    titleSort,
    albumSort,
    handleTitleSort,
    handleAlbumSort,
  } = useSongSort(filteredSongs, undefined, 'liked')

  const handlePlaySong = useCallback(
    (song: Song) => {
      playSong(song, filteredAndSortedSongs, 'liked')
    },
    [playSong, filteredAndSortedSongs]
  )

  const handlePlayAll = useCallback(() => {
    if (filteredAndSortedSongs.length > 0) {
      playSong(filteredAndSortedSongs[0], filteredAndSortedSongs, 'liked')
    }
  }, [playSong, filteredAndSortedSongs])

  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  return (
    <div className="h-full flex flex-col select-none">
      <ViewHeader
        title="我喜欢"
        count={filteredAndSortedSongs.length}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onRefresh={refreshAll}
        isLoading={isLoading}
        actions={
          filteredAndSortedSongs.length > 0 ? (
            <button
              onClick={handlePlayAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors active:scale-95"
              style={{
                backgroundColor: hexToRgba(primaryColor, 0.2),
                color: primaryColor,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = hexToRgba(primaryColor, 0.3)
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = hexToRgba(primaryColor, 0.2)
              }}
            >
              <Play size={14} className="fill-current" />
              播放全部
            </button>
          ) : null
        }
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
        emptyIcon={<Heart size={48} className="mb-4 opacity-50" />}
        emptyTitle="暂无喜欢的歌曲"
        emptyDescription="点击歌曲旁边的爱心图标添加到我喜欢"
        source="liked"
      />
    </div>
  )
}
