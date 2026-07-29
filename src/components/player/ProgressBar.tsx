import { useRef, useState, useEffect, useCallback, useMemo, memo } from 'react'
import { formatDuration } from '../../utils/format'
import { useThemeStore } from '../../stores/themeStore'
import { THEMES } from '../../config/themes'
import { usePlayerStore } from '../../stores/playerStore'
import { APP_CONFIG } from '../../config'
import { cn } from '../../utils/cn'

interface ProgressBarProps {
  duration: number
  onSeek: (time: number) => void
}

function ProgressBar({ duration, onSeek }: ProgressBarProps) {
  const progressRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [displayTime, setDisplayTime] = useState(0)
  const displayTimeRef = useRef(displayTime)
  const isDraggingRef = useRef(false)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  const progress = duration > 0 ? (displayTime / duration) * 100 : 0

  // H2 修复：稳定的 style 对象，避免每帧创建新对象引发子组件无意义重渲染
  const trackStyle = useMemo(
    () => ({
      backgroundColor: primaryColor,
      transition: isDragging ? 'none' : 'width 0.1s linear',
    }),
    [primaryColor, isDragging]
  )
  const thumbStyle = useMemo(() => ({ backgroundColor: primaryColor }), [primaryColor])

  // 外部订阅 currentTime，节流到 10fps（100ms），配合 CSS transition 保证视觉平滑
  // 避免直接订阅 currentTime 导致 60fps 重渲染
  useEffect(() => {
    isDraggingRef.current = isDragging
    // 拖拽结束后立即同步一次当前播放位置
    if (!isDragging) {
      const t = usePlayerStore.getState().currentTime
      setDisplayTime(t)
      displayTimeRef.current = t
    }
  }, [isDragging])

  useEffect(() => {
    // 挂载时同步当前播放位置，避免初始闪烁
    const t = usePlayerStore.getState().currentTime
    setDisplayTime(t)
    displayTimeRef.current = t

    let lastUpdate = 0
    const unsubscribe = usePlayerStore.subscribe((state) => {
      if (isDraggingRef.current) return
      const now = performance.now()
      if (now - lastUpdate < 100) return
      lastUpdate = now
      const t = state.currentTime
      setDisplayTime(t)
      displayTimeRef.current = t
    })
    return unsubscribe
  }, [])

  const handleSeek = useCallback(
    (newTime: number) => {
      if (duration <= 0) return
      const clampedTime = Math.max(0, Math.min(duration, newTime))
      setDisplayTime(clampedTime)
      onSeek(clampedTime)
    },
    [duration, onSeek]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressRef.current || duration <= 0) return

      const rect = progressRef.current.getBoundingClientRect()
      if (rect.width === 0) return
      const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const newTime = percentage * duration
      handleSeek(newTime)
    },
    [duration, handleSeek]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressRef.current || duration <= 0) return

      setIsDragging(true)
      const rect = progressRef.current.getBoundingClientRect()
      if (rect.width === 0) return
      const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const newTime = percentage * duration
      setDisplayTime(newTime)
      // 同步 ref，否则 handleMouseUp 会使用拖拽前的旧值 seek
      displayTimeRef.current = newTime
    },
    [duration]
  )

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      if (duration <= 0) return
      const newTime = Math.max(
        0,
        Math.min(
          duration,
          displayTime +
            (e.deltaY > 0
              ? -APP_CONFIG.player.seekWheelStepSecs
              : APP_CONFIG.player.seekWheelStepSecs)
        )
      )
      handleSeek(newTime)
    },
    [duration, displayTime, handleSeek]
  )

  // 键盘无障碍：←/→ ±5s，Ctrl+←/→ ±10%，Home/End 跳首尾
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (duration <= 0) return
      const bigStep = duration * 0.1
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          handleSeek(
            displayTime - (e.ctrlKey || e.metaKey ? bigStep : APP_CONFIG.player.seekStepSecs)
          )
          break
        case 'ArrowRight':
          e.preventDefault()
          handleSeek(
            displayTime + (e.ctrlKey || e.metaKey ? bigStep : APP_CONFIG.player.seekStepSecs)
          )
          break
        case 'Home':
          e.preventDefault()
          handleSeek(0)
          break
        case 'End':
          e.preventDefault()
          handleSeek(duration)
          break
        default:
          break
      }
    },
    [duration, displayTime, handleSeek]
  )

  // React onWheel 是 passive 监听器，preventDefault 无效且有 console warning
  // 用原生 addEventListener({passive: false}) 替代；ref 模式避免频繁重绑定
  const handleWheelRef = useRef(handleWheel)
  useEffect(() => {
    handleWheelRef.current = handleWheel
  }, [handleWheel])

  useEffect(() => {
    const el = progressRef.current
    if (!el) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (progressRef.current && duration > 0) {
        const rect = progressRef.current.getBoundingClientRect()
        const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const newTime = percentage * duration
        setDisplayTime(newTime)
        // 同步 ref，否则 handleMouseUp 会使用拖拽前的旧值 seek
        displayTimeRef.current = newTime
      }
    }

    const handleMouseUp = () => {
      if (duration > 0) {
        handleSeek(displayTimeRef.current)
      }
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, duration, handleSeek])

  return (
    <div className="w-full flex items-center gap-2">
      <span className="text-xs text-zinc-400 w-10 text-right select-none">
        {formatDuration(displayTime)}
      </span>
      <div
        ref={progressRef}
        className="flex-1 h-6 flex items-center cursor-pointer group py-2 -my-2 rounded"
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.floor(displayTime)}
        aria-valuetext={`${formatDuration(displayTime)} / ${formatDuration(duration)}`}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
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
            className="h-full rounded-full relative"
            style={{ ...trackStyle, width: `${progress}%` }}
          >
            <div
              className={cn(
                'absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full',
                'transition-[opacity,transform] duration-150',
                isDragging
                  ? 'opacity-100 scale-110'
                  : 'opacity-0 group-hover:opacity-100 group-hover:scale-110'
              )}
              style={thumbStyle}
            />
          </div>
        </div>
      </div>
      <span className="text-xs text-zinc-400 w-10 select-none">{formatDuration(duration)}</span>
    </div>
  )
}

// M5 修复：memo 包裹，props (duration, onSeek) 引用稳定，避免父组件重渲染波及
export default memo(ProgressBar)
