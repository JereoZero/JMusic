import { memo, useCallback } from 'react'
import { Heart, Eye, EyeOff, AlertCircle, Play, Check } from 'lucide-react'
import type { Song } from '../types'
import { formatDuration } from '../utils/format'
import { useSongCover } from '../hooks/useSongCover'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'
import { APP_CONFIG } from '../config'
import { AUDIO_FORMATS } from '../constants'
import { cn } from '../utils/cn'
import { getSongListGridColumns, type SongListColumnConfig } from './songListColumns'

const UNSUPPORTED = new Set<string>(AUDIO_FORMATS.unsupported)
const SUPPORTED_FORMATS: Set<string> = new Set(
  AUDIO_FORMATS.normal.filter((f) => !UNSUPPORTED.has(f))
)

function isSupportedFormat(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop()
  return ext ? SUPPORTED_FORMATS.has(ext) : false
}

export interface SongItemProps {
  song: Song
  index: number
  isCurrent: boolean
  isLiked: boolean
  isHidden: boolean
  isSelected?: boolean
  columnConfig: SongListColumnConfig
  onPlay: (song: Song) => void
  onToggleLike: (path: string) => void
  onToggleHidden: (path: string) => void
  onItemClick?: (song: Song, index: number, e: React.MouseEvent) => void
}

const SongItem = memo(function SongItem({
  song,
  index,
  isCurrent,
  isLiked,
  isHidden,
  isSelected = false,
  columnConfig,
  onPlay,
  onToggleLike,
  onToggleHidden,
  onItemClick,
}: SongItemProps) {
  const { cover } = useSongCover(song.path)
  const isPlayable = isSupportedFormat(song.path)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  const handleToggleLike = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleLike(song.path)
    },
    [onToggleLike, song.path]
  )

  const handleToggleHidden = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleHidden(song.path)
    },
    [onToggleHidden, song.path]
  )

  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      if (!isPlayable) return
      e.stopPropagation()
      onPlay(song)
    },
    [onPlay, song, isPlayable]
  )

  // 单击交由 SongList 处理多选逻辑
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onItemClick) onItemClick(song, index, e)
    },
    [onItemClick, song, index]
  )

  return (
    <div
      className={cn(
        'song-item group grid items-center',
        'rounded-lg transition-all duration-200 cursor-pointer',
        'hover:bg-white/[0.04]',
        isCurrent && 'bg-white/[0.08]',
        isSelected && 'bg-white/[0.06] ring-1 ring-inset',
        !isPlayable && 'opacity-50'
      )}
      style={{
        height: '100%',
        gridTemplateColumns: getSongListGridColumns(columnConfig),
        gap: '16px',
        ...(isSelected
          ? { boxShadow: `inset 2px 0 0 ${primaryColor}`, backgroundColor: `${primaryColor}14` }
          : undefined),
      }}
      onClick={handleClick}
      onDoubleClick={handlePlay}
    >
      <div className="flex justify-center items-center text-safe-sm tabular-nums">
        {isSelected ? (
          <div
            className="w-4 h-4 rounded flex items-center justify-center"
            style={{ backgroundColor: primaryColor }}
          >
            <Check size={12} className="text-white" />
          </div>
        ) : isCurrent ? (
          <div className="flex items-center justify-end gap-0.5">
            {/* H3 修复：CSS keyframes 替代 motion.div，避免每行注册独立 RAF 订阅 */}
            <div className="eq-bar" style={{ backgroundColor: primaryColor }} />
            <div className="eq-bar eq-bar-delay-1" style={{ backgroundColor: primaryColor }} />
            <div className="eq-bar eq-bar-delay-2" style={{ backgroundColor: primaryColor }} />
          </div>
        ) : (
          <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
            {index + 1}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <div className="relative w-10 h-10 rounded-lg flex-shrink-0 overflow-hidden bg-white/5 group-hover:shadow-md transition-shadow">
          {cover ? (
            <img
              src={`data:image/jpeg;base64,${cover}`}
              alt={song.title}
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-5 h-5 text-zinc-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Play size={16} className="text-white ml-0.5" />
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="font-medium text-safe-sm truncate flex items-center gap-2">
            <span style={{ color: isCurrent ? primaryColor : undefined }}>{song.title}</span>
            {!isPlayable && (
              <span className="flex items-center gap-1 text-safe-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded-md flex-shrink-0">
                <AlertCircle size={12} />
                不支持
              </span>
            )}
          </div>
          <div className="text-safe-sm text-zinc-500 truncate">{song.artist || '未知歌手'}</div>
        </div>
      </div>

      <div className="hidden md:block overflow-hidden">
        <span className="text-safe-sm text-zinc-600 truncate block">{song.album || '-'}</span>
      </div>

      {columnConfig.showLike && (
        <div className="flex justify-center">
          <button
            onClick={handleToggleLike}
            className={cn(
              'p-2 rounded-full transition-all duration-200',
              'hover:bg-white/5 opacity-0 group-hover:opacity-100',
              isLiked && 'opacity-100'
            )}
            title={isLiked ? '取消喜欢' : '添加到喜欢'}
            aria-label={isLiked ? '取消喜欢' : '添加到喜欢'}
          >
            <Heart
              size={16}
              style={{
                color: isLiked ? primaryColor : APP_CONFIG.theme.iconInactive,
                fill: isLiked ? primaryColor : 'none',
              }}
            />
          </button>
        </div>
      )}

      {columnConfig.showHide && (
        <div className="flex justify-center">
          <button
            onClick={handleToggleHidden}
            className={cn(
              'p-2 rounded-full transition-all duration-200',
              'hover:bg-white/5 opacity-0 group-hover:opacity-100',
              isHidden && 'opacity-100'
            )}
            title={isHidden ? '取消隐藏' : '隐藏歌曲'}
            aria-label={isHidden ? '取消隐藏' : '隐藏歌曲'}
          >
            {isHidden ? (
              <EyeOff size={16} className="text-zinc-500" />
            ) : (
              <Eye size={16} className="text-zinc-500" />
            )}
          </button>
        </div>
      )}

      <div className="flex justify-center items-center">
        <span className="text-safe-sm text-zinc-600 tabular-nums">{formatDuration(song.duration)}</span>
      </div>
    </div>
  )
})

export default SongItem
