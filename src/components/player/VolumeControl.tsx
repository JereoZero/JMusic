import { useRef, useState, useEffect, useCallback, memo } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { usePlayerStore } from '../../stores/playerStore'
import { useThemeStore } from '../../stores/themeStore'
import { THEMES } from '../../config/themes'
import { APP_CONFIG } from '../../config'
import { cn } from '../../utils/cn'

interface VolumeControlProps {
  onVolumeChange: (volume: number) => void
}

function VolumeControl({ onVolumeChange }: VolumeControlProps) {
  // H9 修复：自订阅 volume，避免 PlayerBar 因 volume 变化重渲染
  const volume = usePlayerStore((s) => s.volume)
  const volumeRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [previousVolume, setPreviousVolume] = useState(volume)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  const toggleMute = useCallback(() => {
    if (isMuted) {
      onVolumeChange(previousVolume)
      setIsMuted(false)
    } else {
      setPreviousVolume(volume)
      onVolumeChange(0)
      setIsMuted(true)
    }
  }, [isMuted, volume, previousVolume, onVolumeChange])

  useEffect(() => {
    if (!isMuted) {
      setPreviousVolume(volume)
    }
  }, [volume, isMuted])

  const handleVolumeChange = useCallback(
    (percentage: number) => {
      const newVolume = Math.max(0, Math.min(1, percentage))
      onVolumeChange(newVolume)
      if (newVolume > 0) {
        setIsMuted(false)
      }
    },
    [onVolumeChange]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!volumeRef.current) return

      setIsDragging(true)
      const rect = volumeRef.current.getBoundingClientRect()
      const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      handleVolumeChange(percentage)
    },
    [handleVolumeChange]
  )

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const newVolume = Math.max(
        0,
        Math.min(
          1,
          volume +
            (e.deltaY > 0 ? -APP_CONFIG.player.volumeWheelStep : APP_CONFIG.player.volumeWheelStep)
        )
      )
      handleVolumeChange(newVolume)
    },
    [volume, handleVolumeChange]
  )

  // 键盘无障碍：↑/→ +0.1，↓/← -0.1，Home 满，End 静音，M 切换静音
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          e.preventDefault()
          handleVolumeChange(volume + APP_CONFIG.player.volumeStep)
          break
        case 'ArrowDown':
        case 'ArrowLeft':
          e.preventDefault()
          handleVolumeChange(volume - APP_CONFIG.player.volumeStep)
          break
        case 'Home':
          e.preventDefault()
          handleVolumeChange(1)
          break
        case 'End':
          e.preventDefault()
          handleVolumeChange(0)
          break
        case 'm':
        case 'M':
          e.preventDefault()
          toggleMute()
          break
        default:
          break
      }
    },
    [volume, handleVolumeChange, toggleMute]
  )

  // React onWheel 是 passive 监听器，preventDefault 无效且有 console warning
  // 用原生 addEventListener({passive: false}) 替代；ref 模式避免频繁重绑定
  const handleWheelRef = useRef(handleWheel)
  useEffect(() => {
    handleWheelRef.current = handleWheel
  }, [handleWheel])

  useEffect(() => {
    const el = volumeRef.current
    if (!el) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (volumeRef.current) {
        const rect = volumeRef.current.getBoundingClientRect()
        const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        handleVolumeChange(percentage)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, handleVolumeChange])

  return (
    <div className="flex items-center gap-2">
      <div
        ref={volumeRef}
        className="w-24 h-6 flex items-center cursor-pointer group py-2 -my-2 rounded"
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        role="slider"
        aria-label="音量"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={isMuted ? 0 : volume}
        aria-valuetext={`${Math.round((isMuted ? 0 : volume) * 100)}%`}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End M"
        tabIndex={0}
      >
        <div
          className={cn(
            'w-full rounded-full relative transition-[height] duration-150 ease-out',
            isDragging ? 'h-1.5' : 'h-1 group-hover:h-1.5'
          )}
          style={{ backgroundColor: 'var(--track-bg)' }}
        >
          <div
            className="h-full rounded-full relative transition-colors"
            style={{
              width: `${(isMuted ? 0 : volume) * 100}%`,
              backgroundColor: primaryColor,
            }}
          >
            <div
              className={cn(
                'absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full',
                'transition-[opacity,transform] duration-150',
                isDragging
                  ? 'opacity-100 scale-110'
                  : 'opacity-0 group-hover:opacity-100 group-hover:scale-110'
              )}
              style={{ backgroundColor: primaryColor }}
            />
          </div>
        </div>
      </div>
      <button
        onClick={toggleMute}
        className="p-1 rounded-full transition-all duration-200 hover:bg-white/10"
        title={isMuted ? '取消静音' : '静音'}
        aria-label={isMuted ? '取消静音' : '静音'}
      >
        {isMuted ? (
          <VolumeX size={18} className="text-zinc-400" />
        ) : (
          <Volume2 size={18} className="text-zinc-400" />
        )}
      </button>
    </div>
  )
}

export default memo(VolumeControl)
