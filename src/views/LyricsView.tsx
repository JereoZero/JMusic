import { X, ChevronDown } from 'lucide-react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useCoverStore } from '../stores/coverStore'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'
import api from '../api'
import LyricParser from 'lrc-file-parser'
import { createErrorHandler } from '../utils/errorHandler'
import { useOperationLogStore } from '../stores/operationLogStore'
import { cn } from '../utils/cn'
import { motion, AnimatePresence } from 'framer-motion'

interface LyricsViewProps {
  onClose: () => void
}

interface LyricLine {
  time: number
  text: string
}

export default function LyricsView({ onClose }: LyricsViewProps) {
  const currentSong = usePlayerStore((state) => state.currentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const seek = usePlayerStore((state) => state.seek)
  const togglePlay = usePlayerStore((state) => state.togglePlay)

  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [lineIndex, setLineIndex] = useState(-1)
  const [isLoading, setIsLoading] = useState(false)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const [isMouseOverLyrics, setIsMouseOverLyrics] = useState(false)
  // 歌词平移模式：高亮固定在中间，内容用 transform 流动
  // 直接用 ref + DOM 操作，避免 React state 渲染时序导致 transition/transform 不生效
  const lyricsContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null) // 被 transform 平移的内容容器
  const currentLineRef = useRef<HTMLDivElement>(null)
  const lyricParserRef = useRef<LyricParser | null>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lyricLinesRef = useRef<LyricLine[]>([])
  const autoOffsetRef = useRef(0) // 自动偏移（让当前行到容器中间）
  const manualOffsetRef = useRef(0) // 用户滚轮手动偏移（临时浏览）
  lyricLinesRef.current = lyricLines

  // C8 修复：订阅全局 coverStore，避免独立调用 useSongCover+useAlbumColor
  const coverBase64 = useCoverStore((s) => s.cover)
  const bgColor = useCoverStore((s) => s.colors.lyrics) || '#181818'
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  // isPaused 直接派生自 isPlaying，无需独立 state（避免额外渲染）
  const isPaused = !isPlaying

  // 外部订阅 currentTime，仅在歌词行变化时触发 React 重渲染（避免 60fps 重渲染）
  useEffect(() => {
    let lastLineIdx = -1

    // 根据 currentTime 计算当前行索引（二分搜索 O(log n)，歌词时间戳已排序）
    const computeLineIndex = (currentTime: number) => {
      const lines = lyricLinesRef.current
      if (lines.length === 0) return -1
      const timeMs = currentTime * 1000
      // 找最大的 i 使得 lines[i].time <= timeMs
      let lo = 0, hi = lines.length - 1, result = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (lines[mid].time <= timeMs) {
          result = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return result
    }

    // 立即用当前 currentTime 计算一次，不等 subscribe 触发
    // 解决：歌词加载完成后 subscribe 重新注册，若 currentTime 未变化则 lineIndex 一直是 -1
    const initialIdx = computeLineIndex(usePlayerStore.getState().currentTime)
    if (initialIdx !== lastLineIdx) {
      lastLineIdx = initialIdx
      setLineIndex(initialIdx)
    }

    const unsubscribe = usePlayerStore.subscribe((state) => {
      const currentTime = state.currentTime
      const newIdx = computeLineIndex(currentTime)
      if (newIdx !== lastLineIdx) {
        lastLineIdx = newIdx
        setLineIndex(newIdx)
      }
    })
    return unsubscribe
  }, [lyricLines])

  useEffect(() => {
    const songPath = currentSong?.path
    if (!songPath) {
      setLyricLines([])
      return
    }

    let cancelled = false
    const log = useOperationLogStore.getState().log

    setIsLoading(true)
    api
      .getLyrics(songPath)
      .then((source) => {
        if (cancelled) return
        if (source?.content) {
          if (lyricParserRef.current) {
            lyricParserRef.current.pause()
          }

          lyricParserRef.current = new LyricParser({
            onPlay: () => {},
            onSetLyric: (lines: LyricLine[]) => {
              if (!cancelled) setLyricLines(lines)
            },
            offset: 100,
            isRemoveBlankLine: true,
          })

          lyricParserRef.current.setLyric(source.content)
          log('歌词加载', `${currentSong?.title || '未知'} - ${source.content.length} 字符`)
        } else {
          setLyricLines([])
          log('歌词加载', `${currentSong?.title || '未知'} - 无歌词`)
        }
      })
      .catch((e) => {
        console.error('Failed to load lyrics:', e)
        if (!cancelled) setLyricLines([])
        log('歌词加载', currentSong?.title, e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
      if (lyricParserRef.current) {
        lyricParserRef.current.pause()
      }
    }
  }, [currentSong?.path, currentSong?.title])

  // 直接操作 DOM 应用 transform，绕过 React state 渲染时序
  // 避免 setContentOffset 后 style 不立即生效导致 transition 动画丢失
  const applyTransform = useCallback((transition: string) => {
    const el = contentRef.current
    if (!el) return
    el.style.transition = transition
    el.style.transform = `translateY(${autoOffsetRef.current + manualOffsetRef.current}px)`
  }, [])

  // 自动平移歌词内容：让当前行固定在容器中间（高亮不动，内容流动）
  // 依赖 lyricLines：歌词加载完成时也触发，解决"进入页面不滚动"问题
  useEffect(() => {
    if (isUserScrolling) return
    if (lyricLines.length === 0) return

    const container = lyricsContainerRef.current
    if (!container) return

    // ref 可能因 motion.div 设置时机问题为 null，用 querySelector 兜底
    let line: HTMLElement | null = currentLineRef.current
    if (!line) {
      line = container.querySelector(`[data-line-index="${lineIndex}"]`)
    }
    if (!line) return

    // offsetTop 是布局位置，不受 transform 影响（transform 是视觉变换）
    // container 是 offsetParent（有 position: relative）
    const lineCenter = line.offsetTop + line.offsetHeight / 2
    const containerCenter = container.clientHeight / 2
    autoOffsetRef.current = containerCenter - lineCenter
    manualOffsetRef.current = 0
    applyTransform('transform 0.7s cubic-bezier(0.33, 0, 0.67, 1)')
  }, [lineIndex, isUserScrolling, lyricLines, applyTransform])

  // 事件委托：单一 onClick 处理所有歌词行点击
  const handleLyricClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.currentTarget as HTMLElement
      const timeStr = target.dataset.time
      if (timeStr) {
        // clamp 到 [0, duration]，防止异常 LRC 时间戳 seek 到无效位置
        const rawTime = Number(timeStr) / 1000
        const maxTime = currentSong?.duration ?? 0
        const clampedTime = maxTime > 0 ? Math.max(0, Math.min(maxTime, rawTime)) : Math.max(0, rawTime)
        seek(clampedTime).catch(createErrorHandler('歌词跳转'))
        useOperationLogStore.getState().log('歌词跳转', `→ ${clampedTime.toFixed(1)}s`)
      }
    },
    [seek, currentSong]
  )

  const handleCoverClick = useCallback(async () => {
    await togglePlay()
  }, [togglePlay])

  // 用户滚轮：临时手动浏览歌词（调整 manualOffset），6 秒后恢复自动跟随
  // 用 wheel 而非 onScroll：wheel 只在用户主动滚动时触发，程序 transform 不触发
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const wasScrolling = isUserScrolling
    setIsUserScrolling(true)
    // 滚轮向下（deltaY > 0）→ 内容向上（manualOffset 减小）
    manualOffsetRef.current -= e.deltaY
    applyTransform('transform 0.1s ease-out')

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
    }

    scrollTimeoutRef.current = setTimeout(() => {
      setIsUserScrolling(false)
      useOperationLogStore.getState().log('歌词滚动', '恢复自动跟随', `lineIndex=${lineIndex}`)
    }, 6000)

    // 仅在滚动开始时记录一次，避免日志爆炸
    if (!wasScrolling) {
      useOperationLogStore.getState().log('歌词滚动', '用户手动浏览', `lineIndex=${lineIndex}`)
    }
  }, [applyTransform, isUserScrolling, lineIndex])

  // 手动回到当前播放行：清除手动偏移，立即恢复自动跟随
  const handleResumeFollow = useCallback(() => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
    }
    manualOffsetRef.current = 0
    setIsUserScrolling(false)
    useOperationLogStore.getState().log('歌词滚动', '手动归位', `lineIndex=${lineIndex}`)
  }, [lineIndex])

  const handleMouseEnter = useCallback(() => {
    setIsMouseOverLyrics(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsMouseOverLyrics(false)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  if (!currentSong) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-black/20 text-zinc-600">
        <p>暂无歌曲</p>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onClose}
          className="mt-4 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors text-sm"
        >
          返回
        </motion.button>
      </div>
    )
  }

  const title = currentSong.title || '未知歌曲'
  const artist = currentSong.artist || '未知歌手'
  const album = currentSong.album || '未知专辑'

  return (
    <div className="h-full flex relative overflow-hidden">
      {/* C13 修复：背景层降到 300ms，减少 repaint 时长 */}
      <div
        className="absolute inset-0 transition-colors duration-300"
        style={{
          backgroundColor: bgColor,
          transitionTimingFunction: 'cubic-bezier(0.33, 0, 0.67, 1)',
        }}
      />

      {/* 内容层 */}
      <div className="relative h-full w-full flex">
        {/* 最左侧功能栏点击区域 - 退出歌词 */}
        <div
          className="absolute left-0 top-0 bottom-0 w-16 z-20 cursor-pointer"
          onClick={onClose}
          title="点击返回"
        />

        {/* 关闭按钮 */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={onClose}
          className="absolute top-9 right-4 p-2 rounded-full hover:bg-white/10 transition-colors z-30 text-zinc-500 hover:text-white"
          aria-label="关闭歌词"
        >
          <X size={24} />
        </motion.button>

        {/* 左侧专辑区域 */}
        <div className="w-[35%] h-full flex flex-col items-center justify-center px-8 z-10 ml-8">
          <div className="flex flex-col items-center gap-4">
            {/* C2 修复：封面用 transform: scale 替代 width/height 动画，避免 layout reflow */}
            <motion.div
              animate={{ scale: isPaused ? 200 / 280 : 1 }}
              transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
              className="rounded-xl overflow-hidden bg-white/5 flex items-center justify-center cursor-pointer select-none shadow-2xl"
              style={{ width: 280, height: 280, transformOrigin: 'center' }}
              onClick={handleCoverClick}
              title={isPaused ? '点击播放' : '点击暂停'}
            >
              {coverBase64 ? (
                <img
                  src={`data:image/jpeg;base64,${coverBase64}`}
                  alt={title}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg className="w-20 h-20 text-zinc-700" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                  </svg>
                </div>
              )}
            </motion.div>

            {/* 歌曲信息 */}
            <div className="text-center" style={{ width: '280px' }}>
              <h2 className="text-xl font-bold text-white mb-2 truncate">{title}</h2>
              <p className="text-sm text-zinc-500 mb-1 truncate">专辑：{album}</p>
              <p className="text-sm text-zinc-500 truncate">歌手：{artist}</p>
              {isPaused && (
                <div
                  className="mt-4 w-12 h-0.5 mx-auto rounded-full"
                  style={{ backgroundColor: primaryColor }}
                />
              )}
            </div>
          </div>
        </div>

        {/* 右侧歌词区域 */}
        <div className="flex-1 h-full flex flex-col py-8 z-10">
          <div
            ref={lyricsContainerRef}
            className="flex-1 overflow-hidden px-8 relative"
            onWheel={handleWheel}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-2 text-zinc-600">
                  {/* H4 修复：用 Tailwind animate-spin 替代 motion.div，零 JS 开销 */}
                  <div className="w-4 h-4 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm">加载歌词中...</p>
                </div>
              </div>
            ) : lyricLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full">
                <p className="text-zinc-600 text-sm">暂无歌词</p>
                <p className="text-xs mt-2 text-zinc-700">可将 .lrc 歌词文件放在歌曲同目录下</p>
              </div>
            ) : (
              <div
                ref={contentRef}
                className="py-32 text-center"
              >
                {lyricLines.map((line, index) => {
                  const isCurrent = index === lineIndex
                  const isPast = index < lineIndex
                  const distance = Math.abs(index - lineIndex)

                  let opacity = 1
                  if (!isMouseOverLyrics && distance > 2) {
                    opacity = Math.max(0, 1 - (distance - 2) * 0.15)
                  }

                  // C1 修复：motion.div 改 div + CSS transition，避免长歌词每个 motion 注册订阅
                  // H14 修复：移除 filter: blur，仅保留 opacity 渐变，减少 GPU 合成层
                  return (
                    <div
                      key={`${line.time}-${index}`}
                      data-time={line.time}
                      data-line-index={index}
                      ref={isCurrent ? currentLineRef : null}
                      onClick={handleLyricClick}
                      className={cn(
                        'py-4 px-4 rounded-xl cursor-pointer mb-2',
                        'transition-[color,transform,opacity] duration-500 ease-in-out',
                        isCurrent
                          ? 'text-white text-3xl font-medium scale-110'
                          : isPast
                            ? 'text-zinc-700 text-2xl hover:text-zinc-500'
                            : 'text-zinc-600 text-2xl hover:text-zinc-400 hover:bg-white/[0.03]'
                      )}
                      style={opacity < 1 ? { opacity } : undefined}
                    >
                      <span>{line.text}</span>
                    </div>
                  )
                })}
              </div>
            )}
            {/* 用户手动滚动时显示"回到当前播放"浮动按钮 */}
            <AnimatePresence>
              {isUserScrolling && (
                <motion.button
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.2 }}
                  onClick={handleResumeFollow}
                  className="absolute bottom-6 right-8 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-white shadow-lg"
                  style={{ backgroundColor: primaryColor }}
                >
                  <ChevronDown size={14} />
                  回到当前播放
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}
