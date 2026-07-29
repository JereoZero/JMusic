import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, ListMusic, Play } from 'lucide-react'
import type { Song } from '../../types'
import { usePlayQueueStore } from '../../stores/playQueueStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useThemeStore } from '../../stores/themeStore'
import { confirmDialog } from '../../stores/dialogStore'
import { THEMES } from '../../config/themes'
import { cn } from '../../utils/cn'

interface QueuePanelProps {
  open: boolean
  onClose: () => void
}

interface QueueItemProps {
  song: Song
  index: number
  isCurrent: boolean
  primaryColor: string
  onPlay: (index: number) => void
  onRemove: (index: number) => void
}

// H5 修复：抽 QueueItem 组件并 memo，避免 200 项列表全量重渲染
const QueueItem = memo(function QueueItem({
  song,
  index,
  isCurrent,
  primaryColor,
  onPlay,
  onRemove,
}: QueueItemProps) {
  return (
    <div
      onClick={() => onPlay(index)}
      className={cn(
        'group flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors',
        isCurrent ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
      )}
      style={isCurrent ? { borderLeft: `2px solid ${primaryColor}` } : undefined}
    >
      {/* 序号/播放图标 */}
      <div className="w-5 flex-shrink-0 flex items-center justify-center">
        {isCurrent ? (
          <Play size={14} fill={primaryColor} style={{ color: primaryColor }} />
        ) : (
          <span className="text-xs text-zinc-600 group-hover:hidden">{index + 1}</span>
        )}
        {!isCurrent && <Play size={12} className="hidden group-hover:block text-zinc-400" />}
      </div>

      {/* 歌曲信息 */}
      <div className="min-w-0 flex-1">
        <p
          className={cn('text-sm truncate', isCurrent ? 'font-medium' : 'text-zinc-300')}
          style={isCurrent ? { color: primaryColor } : undefined}
        >
          {song.title}
        </p>
        <p className="text-xs text-zinc-600 truncate">{song.artist}</p>
      </div>

      {/* 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove(index)
        }}
        className="p-1 rounded-full text-zinc-600 hover:text-red-400 hover:bg-white/5 transition-colors flex-shrink-0"
        title="从队列移除"
        aria-label="从队列移除"
      >
        <X size={14} />
      </button>
    </div>
  )
})

function QueuePanel({ open, onClose }: QueuePanelProps) {
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  const { queue, removeFromQueue, clearQueue } = usePlayQueueStore(
    useShallow((s) => ({
      queue: s.queue,
      removeFromQueue: s.removeFromQueue,
      clearQueue: s.clearQueue,
    }))
  )
  const playSongAtIndex = usePlayerStore((s) => s.playSongAtIndex)
  const currentSongPath = usePlayerStore((s) => s.currentSong?.path)

  // 当前面板中需要展示的歌曲（最多 200 首，避免大队列卡顿）
  const displayQueue = useMemo(() => queue.slice(0, 200), [queue])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩层 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={onClose}
          />
          {/* 队列面板 */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.33, 0, 0.67, 1] }}
            className="fixed right-0 top-0 bottom-0 w-96 bg-[#1a1a1a] border-l border-white/5 z-50 flex flex-col"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <div className="flex items-center gap-2">
                <ListMusic size={18} style={{ color: primaryColor }} />
                <span className="text-sm font-medium text-white">播放队列</span>
                <span className="text-xs text-zinc-600">{queue.length} 首</span>
              </div>
              <div className="flex items-center gap-1">
                {queue.length > 0 && (
                  <button
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: '清空播放队列？',
                          variant: 'danger',
                          confirmText: '清空',
                        })
                      ) {
                        clearQueue()
                      }
                    }}
                    className="p-1.5 rounded-full text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors"
                    title="清空队列"
                    aria-label="清空队列"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                  title="关闭"
                  aria-label="关闭"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* 队列列表 */}
            <div className="flex-1 overflow-y-auto">
              {displayQueue.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-zinc-600">
                  <ListMusic size={40} className="mb-3 opacity-40" />
                  <p className="text-sm">队列为空</p>
                  <p className="text-xs mt-1 text-zinc-700">点击歌曲将自动加入队列</p>
                </div>
              ) : (
                displayQueue.map((song, index) => (
                  <QueueItem
                    key={`${song.path}-${index}`}
                    song={song}
                    index={index}
                    isCurrent={song.path === currentSongPath}
                    primaryColor={primaryColor}
                    onPlay={playSongAtIndex}
                    onRemove={removeFromQueue}
                  />
                ))
              )}
              {queue.length > 200 && (
                <div className="px-4 py-2 text-center text-xs text-zinc-700">
                  仅显示前 200 首，共 {queue.length} 首
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// H1 修复：memo 包裹，配合 PlayerBar 稳定的 onClose 引用避免不必要重渲染
export default memo(QueuePanel)
