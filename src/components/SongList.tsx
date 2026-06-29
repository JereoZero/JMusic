import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Heart, Eye, ListPlus, X } from 'lucide-react'
import type { Song } from '../types'
import type { QueueSource } from '../stores/playQueueStore'
import type { TitleSortType, AlbumSortType } from '../hooks'
import { APP_CONFIG } from '../config'
import { cn } from '../utils/cn'
import { getSongListGridColumns, type SongListColumnConfig } from './songListColumns'
import SongItem from './SongItem'
import { usePlayQueueStore } from '../stores/playQueueStore'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'

function ClockIcon({ size }: { size: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  )
}

interface SongListProps {
  songs: Song[]
  currentSongPath: string | null
  likedPaths: Set<string>
  hiddenPaths: Set<string>
  onPlay: (song: Song, queue: Song[], source: QueueSource) => void
  onToggleLike: (path: string) => void
  onToggleHidden: (path: string) => void
  onBatchLike?: (paths: string[], liked: boolean) => void
  onBatchHide?: (paths: string[], hidden: boolean) => void
  showLikeButton?: boolean
  showHiddenButton?: boolean
  emptyIcon?: React.ReactNode
  emptyTitle?: string
  emptyDescription?: string
  source?: QueueSource
  showHeader?: boolean
  onTitleSort?: () => void
  onAlbumSort?: () => void
  titleSort?: TitleSortType
  albumSort?: AlbumSortType
}

function getSortIcon(sort?: TitleSortType | AlbumSortType) {
  if (!sort) return null
  if (sort.includes('-asc')) return '↑'
  if (sort.includes('-desc')) return '↓'
  return null
}

function SortButton({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-1.5 text-left transition-colors duration-200',
        'hover:text-zinc-300',
        disabled && 'cursor-default opacity-50',
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export default function SongList({
  songs,
  currentSongPath,
  likedPaths,
  hiddenPaths,
  onPlay,
  onToggleLike,
  onToggleHidden,
  onBatchLike,
  onBatchHide,
  showLikeButton = true,
  showHiddenButton = true,
  emptyIcon,
  emptyTitle = '暂无歌曲',
  emptyDescription = '',
  source = 'local',
  showHeader = true,
  onTitleSort,
  onAlbumSort,
  titleSort = 'default',
  albumSort = 'default',
}: SongListProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const lastSelectedIndexRef = useRef<number>(-1)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const addToQueue = usePlayQueueStore((s) => s.addBatchToQueue)

  const columnConfig = useMemo<SongListColumnConfig>(
    () => ({ showLike: showLikeButton, showHide: showHiddenButton }),
    [showLikeButton, showHiddenButton]
  )

  const virtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => APP_CONFIG.ui.songItemHeight,
    overscan: APP_CONFIG.ui.virtualizerOverscan,
  })

  const items = virtualizer.getVirtualItems()

  // 用 ref 持有最新 songs，使 handlePlay 引用稳定，避免列表项因 onPlay 变化全量重渲染
  const songsRef = useRef(songs)
  songsRef.current = songs

  const handlePlay = useCallback(
    (song: Song) => {
      onPlay(song, songsRef.current, source)
    },
    [onPlay, source]
  )

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set())
    lastSelectedIndexRef.current = -1
  }, [])

  // ESC 清空选择
  useEffect(() => {
    if (selectedPaths.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPaths.size, clearSelection])

  // 列表数据变化（搜索/排序/扫描）时清空选择，避免选中不存在的歌
  useEffect(() => {
    clearSelection()
  }, [songs, clearSelection])

  // 用 ref 持有最新 selectedPaths，让 handleItemClick 引用稳定，避免所有 SongItem 重渲染
  const selectedPathsRef = useRef(selectedPaths)
  selectedPathsRef.current = selectedPaths

  /**
   * 处理 SongItem 点击：
   * - Cmd/Ctrl+Click：切换单首选中
   * - Shift+Click：从上次点击位置到当前范围选中
   * - 普通 Click：若已有选中则清空选中；否则触发原播放
   */
  const handleItemClick = useCallback(
    (song: Song, index: number, e: React.MouseEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const shift = e.shiftKey

      if (cmd) {
        e.stopPropagation()
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          if (next.has(song.path)) next.delete(song.path)
          else next.add(song.path)
          return next
        })
        lastSelectedIndexRef.current = index
        return
      }

      if (shift && lastSelectedIndexRef.current >= 0) {
        e.stopPropagation()
        const start = Math.min(lastSelectedIndexRef.current, index)
        const end = Math.max(lastSelectedIndexRef.current, index)
        // L1 修复：用 functional update 避免快速连击丢失更新
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          for (let i = start; i <= end; i++) {
            const s = songsRef.current[i]
            if (s) next.add(s.path)
          }
          return next
        })
        return
      }

      // 普通 click：有选中则清空，无则交由 onDoubleClick 触发播放
      if (selectedPathsRef.current.size > 0) {
        e.stopPropagation()
        clearSelection()
        return
      }
      // 不阻止，让 SongItem 内部 onDoubleClick 处理播放
    },
    [clearSelection]
  )

  const selectedList = useMemo(() => Array.from(selectedPaths), [selectedPaths])
  const selectedSongs = useMemo(
    () => songs.filter((s) => selectedPaths.has(s.path)),
    [songs, selectedPaths]
  )

  const handleBatchLike = useCallback(
    (liked: boolean) => {
      onBatchLike?.(selectedList, liked)
      clearSelection()
    },
    [onBatchLike, selectedList, clearSelection]
  )

  const handleBatchHide = useCallback(
    (hidden: boolean) => {
      onBatchHide?.(selectedList, hidden)
      clearSelection()
    },
    [onBatchHide, selectedList, clearSelection]
  )

  const handleBatchAddToQueue = useCallback(() => {
    addToQueue(selectedSongs)
    clearSelection()
  }, [selectedSongs, addToQueue, clearSelection])

  if (songs.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-zinc-600">
        {emptyIcon}
        <p className="text-lg mb-2 text-zinc-500">{emptyTitle}</p>
        {emptyDescription && <p className="text-sm text-zinc-600">{emptyDescription}</p>}
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-full flex flex-col overflow-hidden">
      {showHeader && (
        <div
          className="grid items-center px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider border-b border-white/5 select-none flex-shrink-0"
          style={{
            gridTemplateColumns: getSongListGridColumns(columnConfig),
            gap: '16px',
          }}
        >
          <div className="flex justify-center items-center">#</div>

          <SortButton onClick={onTitleSort} disabled={!onTitleSort}>
            <span>标题</span>
            {getSortIcon(titleSort) && (
              <span className="text-zinc-500">{getSortIcon(titleSort)}</span>
            )}
          </SortButton>

          <SortButton onClick={onAlbumSort} disabled={!onAlbumSort} className="hidden md:flex">
            <span>专辑</span>
            {getSortIcon(albumSort) && (
              <span className="text-zinc-500">{getSortIcon(albumSort)}</span>
            )}
          </SortButton>

          {columnConfig.showLike && (
            <div className="flex justify-center">
              <Heart size={14} />
            </div>
          )}

          {columnConfig.showHide && (
            <div className="flex justify-center">
              <Eye size={14} />
            </div>
          )}

          <div className="flex justify-center items-center">
            <ClockIcon size={14} />
          </div>
        </div>
      )}

      {/* 批量操作工具栏 */}
      {selectedPaths.size > 0 && (
        <div
          className="flex items-center justify-between gap-3 px-6 py-2 border-b border-white/10 flex-shrink-0"
          style={{ backgroundColor: `${primaryColor}1a` }}
        >
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-white">已选 {selectedPaths.size} 首</span>
            <span className="text-xs text-zinc-500">Shift+点击多选 · Esc 取消</span>
          </div>
          <div className="flex items-center gap-1">
            {onBatchLike && showLikeButton && (
              <button
                onClick={() => handleBatchLike(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                title="批量添加到喜欢"
              >
                <Heart size={14} />
                <span>喜欢</span>
              </button>
            )}
            {onBatchLike && showLikeButton && (
              <button
                onClick={() => handleBatchLike(false)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                title="批量取消喜欢"
              >
                <Heart size={14} className="opacity-50" />
                <span>取消喜欢</span>
              </button>
            )}
            {onBatchHide && showHiddenButton && (
              <button
                onClick={() => handleBatchHide(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                title="批量隐藏"
              >
                <Eye size={14} className="opacity-50" />
                <span>隐藏</span>
              </button>
            )}
            {onBatchHide && showHiddenButton && (
              <button
                onClick={() => handleBatchHide(false)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                title="批量取消隐藏"
              >
                <Eye size={14} />
                <span>恢复</span>
              </button>
            )}
            <button
              onClick={handleBatchAddToQueue}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
              title="添加到播放队列末尾"
            >
              <ListPlus size={14} />
              <span>加入队列</span>
            </button>
            <button
              onClick={clearSelection}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
              title="取消选择"
            >
              <X size={14} />
              <span>取消</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {items.map((virtualRow) => {
            const song = songs[virtualRow.index]
            const isCurrent = currentSongPath === song.path
            const isLiked = likedPaths.has(song.path)
            const isHidden = hiddenPaths.has(song.path)
            const isSelected = selectedPaths.has(song.path)

            return (
              <div
                key={song.path}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: APP_CONFIG.ui.songItemHeight,
                  transform: `translateY(${virtualRow.start}px)`,
                  willChange: 'transform',
                }}
              >
                <SongItem
                  song={song}
                  index={virtualRow.index}
                  isCurrent={isCurrent}
                  isLiked={isLiked}
                  isHidden={isHidden}
                  isSelected={isSelected}
                  columnConfig={columnConfig}
                  onPlay={handlePlay}
                  onToggleLike={onToggleLike}
                  onToggleHidden={onToggleHidden}
                  onItemClick={handleItemClick}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
