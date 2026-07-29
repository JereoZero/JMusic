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
  // 合并档位：点击循环切换 list → loop → shuffle → list
  onCycleMode: () => void
}

// 播放模式元数据：图标 / 文案 / 高亮
const MODE_META: Record<PlayMode, { label: string; nextLabel: string }> = {
  list: { label: '列表循环', nextLabel: '单曲循环' },
  loop: { label: '单曲循环', nextLabel: '随机播放' },
  shuffle: { label: '随机播放', nextLabel: '列表循环' },
}

function PlaybackControls({
  isPlaying,
  playMode,
  onTogglePlay,
  onPlayPrev,
  onPlayNext,
  onCycleMode,
}: PlaybackControlsProps) {
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const isActive = playMode !== 'list'
  const meta = MODE_META[playMode]

  // M3 修复：CSS hover:scale-110 active:scale-90 替代 motion.button whileHover/whileTap
  const iconButtonClass = cn(
    'p-2 rounded-full transition-all duration-200',
    'text-zinc-500 hover:text-white hover:bg-white/5',
    'hover:scale-110 active:scale-90'
  )

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onCycleMode}
        className={cn(iconButtonClass, isActive && 'text-white')}
        style={isActive ? { color: primaryColor } : undefined}
        title={`${meta.label}（点击切换为${meta.nextLabel}）`}
        aria-label={`${meta.label}，点击切换为${meta.nextLabel}`}
      >
        {playMode === 'shuffle' ? (
          <Shuffle size={18} />
        ) : (
          <div className="relative flex items-center justify-center">
            <Repeat size={18} />
            {playMode === 'loop' && <span className="absolute text-[7px] font-bold">1</span>}
          </div>
        )}
      </button>
      <button onClick={onPlayPrev} className={iconButtonClass} aria-label="上一首">
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
      <button onClick={onPlayNext} className={iconButtonClass} aria-label="下一首">
        <SkipForward size={20} />
      </button>
    </div>
  )
}

export default memo(PlaybackControls)
