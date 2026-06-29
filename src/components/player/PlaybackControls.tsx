import { memo } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat } from 'lucide-react'
import type { PlayMode } from '../../types'
import { useThemeStore } from '../../stores/themeStore'
import { THEMES } from '../../config/themes'
import { cn } from '../../utils/cn'

interface PlaybackControlsProps {
  isPlaying: boolean
  playMode: PlayMode
  onTogglePlay: () => void
  onPlayPrev: () => void
  onPlayNext: () => void
  onToggleShuffle: () => void
  onToggleRepeat: () => void
}

function PlaybackControls({
  isPlaying,
  playMode,
  onTogglePlay,
  onPlayPrev,
  onPlayNext,
  onToggleShuffle,
  onToggleRepeat,
}: PlaybackControlsProps) {
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const isShuffle = playMode === 'shuffle'
  const isLoop = playMode === 'loop'

  // M3 修复：CSS hover:scale-110 active:scale-90 替代 motion.button whileHover/whileTap
  const iconButtonClass = cn(
    'p-2 rounded-full transition-all duration-200',
    'text-zinc-500 hover:text-white hover:bg-white/5',
    'hover:scale-110 active:scale-90'
  )

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onToggleShuffle}
        className={cn(iconButtonClass, isShuffle && 'text-white')}
        style={isShuffle ? { color: primaryColor } : undefined}
        title={isShuffle ? '关闭随机' : '随机播放'}
        aria-label={isShuffle ? '关闭随机' : '随机播放'}
      >
        <Shuffle size={18} />
      </button>
      <button
        onClick={onPlayPrev}
        className={iconButtonClass}
        aria-label="上一首"
      >
        <SkipBack size={20} />
      </button>
      <button
        onClick={onTogglePlay}
        className={cn(
          'p-3 rounded-full transition-all duration-200',
          'shadow-lg hover:shadow-xl hover:brightness-110',
          'hover:scale-105 active:scale-95'
        )}
        style={{ backgroundColor: primaryColor }}
        aria-label={isPlaying ? '暂停' : '播放'}
      >
        <span className="block w-5 h-5 flex items-center justify-center">
          {isPlaying ? (
            <Pause size={20} className="text-white" />
          ) : (
            <Play size={20} className="text-white ml-0.5" />
          )}
        </span>
      </button>
      <button
        onClick={onPlayNext}
        className={iconButtonClass}
        aria-label="下一首"
      >
        <SkipForward size={20} />
      </button>
      <button
        onClick={onToggleRepeat}
        className={cn(iconButtonClass, isLoop && 'text-white')}
        style={isLoop ? { color: primaryColor } : undefined}
        title={isLoop ? '关闭单曲循环' : '单曲循环'}
        aria-label={isLoop ? '关闭单曲循环' : '单曲循环'}
      >
        <div className="relative flex items-center justify-center">
          <Repeat size={18} />
          {isLoop && <span className="absolute text-[7px] font-bold">1</span>}
        </div>
      </button>
    </div>
  )
}

export default memo(PlaybackControls)
