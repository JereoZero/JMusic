import { useCallback, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerSettingsStore, usePlayQueueStore } from '../stores/playQueueStore'
import { useCoverStore } from '../stores/coverStore'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'
import { APP_CONFIG } from '../config'
import { ProgressBar, VolumeControl, PlaybackControls, QueuePanel } from './player'
import { Heart, Eye, EyeOff, ListMusic } from 'lucide-react'
import { cn } from '../utils/cn'

export default function PlayerBar({ onToggleLyrics }: { onToggleLyrics?: () => void }) {
  const currentSong = usePlayerStore((s) => s.currentSong)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const duration = usePlayerStore((s) => s.duration)
  const togglePlay = usePlayerStore((s) => s.togglePlay)
  const playNext = usePlayerStore((s) => s.playNext)
  const playPrev = usePlayerStore((s) => s.playPrev)
  const seek = usePlayerStore((s) => s.seek)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const [showQueue, setShowQueue] = useState(false)
  const queueCount = usePlayQueueStore((s) => s.queue.length)

  // 仅订阅当前歌曲的喜欢/隐藏布尔切片，避免任意歌曲状态变更都触发重渲染
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const toggleHidden = useLibraryStore((s) => s.toggleHidden)
  const isLiked = useLibraryStore((s) =>
    currentSong ? s.likedPaths.has(currentSong.path) : false
  )
  const isHidden = useLibraryStore((s) =>
    currentSong ? s.hiddenPaths.has(currentSong.path) : false
  )
  const playMode = usePlayerSettingsStore((s) => s.settings.playMode)
  const toggleShuffle = usePlayQueueStore((s) => s.toggleShuffle)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const songDuration = duration > 0 ? duration : (currentSong?.duration ?? 0)

  // C8 修复：订阅全局 coverStore，避免独立调用 useSongCover+useAlbumColor 触发 4 倍重渲染
  const cover = useCoverStore((s) => s.cover)
  const playerBarBg = useCoverStore((s) => s.colors.playerBar) || '#181818'

  // 随机按钮：toggleShuffle 内部已根据当前 playMode 决定方向
  const handleToggleShuffle = useCallback(() => {
    toggleShuffle()
  }, [toggleShuffle])

  // 循环按钮：loop <-> list（互斥于 shuffle）
  const handleToggleRepeat = useCallback(() => {
    const settings = usePlayerSettingsStore.getState().settings
    if (settings.playMode === 'loop') {
      usePlayerSettingsStore.getState().setPlayMode('list')
    } else {
      // 若当前是 shuffle，先退出 shuffle 再切 loop
      if (settings.playMode === 'shuffle') {
        usePlayQueueStore.getState().unshuffleQueue()
      }
      usePlayerSettingsStore.getState().setPlayMode('loop')
    }
  }, [])

  // H1 修复：稳定引用，避免破坏 QueuePanel memo
  const handleCloseQueue = useCallback(() => setShowQueue(false), [])
  const handleOpenQueue = useCallback(() => setShowQueue(true), [])

  return (
    <div
      className="h-20 px-5 flex items-center justify-between border-t border-white/5 transition-colors duration-300"
      data-drag-region
      style={{
        backgroundColor: playerBarBg,
        transitionTimingFunction: 'cubic-bezier(0.33, 0, 0.67, 1)',
      }}
    >
      {/* 左侧：歌曲信息 */}
      <div className="w-1/3 flex items-center gap-3 min-w-0">
        <div
          className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 cursor-pointer bg-white/5 transition-transform duration-200 hover:scale-105 active:scale-95"
          onClick={onToggleLyrics}
          data-no-drag
        >
          {cover ? (
            <img
              src={`data:image/jpeg;base64,${cover}`}
              alt={currentSong?.title || ''}
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-6 h-6 text-zinc-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate">
            {currentSong?.title || '未在播放'}
          </p>
          <p className="text-xs truncate text-zinc-500">{currentSong?.artist || ''}</p>
        </div>
      </div>

      {/* 中间：播放控制 + 进度条 */}
      <div className="w-1/3 flex flex-col items-center gap-2">
        <div className="flex items-center gap-3">
          <PlaybackControls
            isPlaying={isPlaying}
            playMode={playMode}
            onTogglePlay={togglePlay}
            onPlayPrev={playPrev}
            onPlayNext={playNext}
            onToggleShuffle={handleToggleShuffle}
            onToggleRepeat={handleToggleRepeat}
          />
          <button
            onClick={() => currentSong && toggleLike(currentSong.path)}
            className={cn(
              'p-2 rounded-full transition-all duration-200',
              'hover:bg-white/5 hover:scale-110 active:scale-90'
            )}
            style={{ color: isLiked ? primaryColor : APP_CONFIG.theme.iconInactive }}
            aria-label={isLiked ? '取消喜欢' : '添加到喜欢'}
          >
            <Heart size={18} fill={isLiked ? primaryColor : 'none'} />
          </button>
        </div>
        <ProgressBar duration={songDuration} onSeek={seek} />
      </div>

      {/* 右侧：隐藏按钮 + 队列 + 音量 */}
      <div className="w-1/3 flex items-center justify-end gap-2">
        <button
          onClick={() => currentSong && toggleHidden(currentSong.path)}
          className={cn(
            'p-2 rounded-full transition-all duration-200',
            'text-zinc-500 hover:text-white hover:bg-white/5',
            'hover:scale-110 active:scale-90'
          )}
          title={isHidden ? '取消隐藏' : '隐藏歌曲'}
          aria-label={isHidden ? '取消隐藏' : '隐藏歌曲'}
        >
          {isHidden ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
        <button
          onClick={handleOpenQueue}
          className={cn(
            'p-2 rounded-full transition-all duration-200 relative',
            showQueue ? 'text-white bg-white/5' : 'text-zinc-500 hover:text-white hover:bg-white/5',
            'hover:scale-110 active:scale-90'
          )}
          title="播放队列"
          aria-label="播放队列"
          data-no-drag
        >
          <ListMusic size={18} />
          {queueCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-medium text-white flex items-center justify-center"
              style={{ backgroundColor: primaryColor }}
            >
              {queueCount > 99 ? '99+' : queueCount}
          </span>
          )}
        </button>
        <VolumeControl onVolumeChange={setVolume} />
      </div>

      <QueuePanel open={showQueue} onClose={handleCloseQueue} />
    </div>
  )
}
