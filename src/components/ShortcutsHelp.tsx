import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect } from 'react'

interface ShortcutGroup {
  title: string
  items: Array<{ keys: string; description: string }>
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '播放控制',
    items: [
      { keys: 'Space', description: '播放 / 暂停' },
      { keys: '⌘ ←', description: '上一首（>3s 时回到开头）' },
      { keys: '⌘ →', description: '下一首' },
      { keys: '←', description: '快退 5 秒' },
      { keys: '→', description: '快进 5 秒' },
      { keys: '↑', description: '音量 +10%' },
      { keys: '↓', description: '音量 -10%' },
    ],
  },
  {
    title: '导航',
    items: [
      { keys: '⌘ F', description: '聚焦搜索框' },
      { keys: '⌘ /', description: '打开 / 关闭快捷键帮助' },
      { keys: 'Esc', description: '关闭歌词 → 退出设置 → 清空搜索' },
    ],
  },
  {
    title: '滑块（聚焦后）',
    items: [
      { keys: '← →', description: '进度 ±5 秒（⌘ ±10%）' },
      { keys: '↑ ↓', description: '音量 ±10%' },
      { keys: 'Home / End', description: '跳到开头 / 结尾（音量：满 / 静音）' },
      { keys: 'M', description: '音量滑块：切换静音' },
    ],
  },
  {
    title: '歌曲列表',
    items: [
      { keys: '双击', description: '播放该歌曲' },
      { keys: '⌘ 点击', description: '切换单首选中' },
      { keys: '⇧ 点击', description: '从上次位置到当前范围多选' },
      { keys: 'Esc', description: '清空选择' },
    ],
  },
  {
    title: '对话框',
    items: [
      { keys: 'Enter', description: '确认' },
      { keys: 'Esc', description: '取消' },
    ],
  },
]

interface ShortcutsHelpProps {
  open: boolean
  onClose: () => void
}

export default function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    // capture 阶段优先吞掉 ESC，避免冒泡到其他全局监听器（如清空搜索/选择）
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: [0.33, 0, 0.67, 1] }}
            className="w-full max-w-lg bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
              <h3 className="text-base font-semibold text-white">键盘快捷键</h3>
              <button
                onClick={onClose}
                className="p-1.5 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 max-h-[70vh] overflow-y-auto">
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.title}>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                    {group.title}
                  </h4>
                  <ul className="space-y-1.5">
                    {group.items.map((item) => (
                      <li
                        key={item.keys}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="text-zinc-300">{item.description}</span>
                        <kbd className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-200 whitespace-nowrap">
                          {item.keys}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="px-5 py-2.5 border-t border-white/5 text-center text-xs text-zinc-600">
              按 Esc 关闭
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
