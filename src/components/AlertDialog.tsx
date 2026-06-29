import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDialogStore } from '../stores/dialogStore'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'
import { cn } from '../utils/cn'

/**
 * 全局确认对话框组件。挂载一次即可，通过 confirmDialog() 编程式触发。
 * 替换浏览器原生 confirm()，与暗色主题统一。
 */
export default function AlertDialog() {
  const { open, options, resolve } = useDialogStore()
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const isDanger = options?.variant === 'danger'

  // ESC 取消、Enter 确认（焦点在按钮上时让浏览器原生 click 触发，避免双重 resolve）
  // 用 capture 阶段 + stopImmediatePropagation 吞掉 ESC，避免冒泡到其他全局监听器
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        resolve(false)
      } else if (e.key === 'Enter') {
        const active = document.activeElement
        if (active && active.tagName === 'BUTTON') {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        resolve(true)
      }
    }
    // capture 阶段优先于冒泡阶段的 react-hotkeys-hook 监听器
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, resolve])

  return (
    <AnimatePresence>
      {open && options && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4"
          onClick={() => resolve(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: [0.33, 0, 0.67, 1] }}
            className="w-full max-w-sm bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5">
              <div className="flex items-start gap-3">
                {isDanger && (
                  <div className="flex-shrink-0 w-9 h-9 rounded-full bg-red-500/15 flex items-center justify-center">
                    <AlertTriangle size={18} className="text-red-400" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-white whitespace-pre-line">
                    {options.title}
                  </h3>
                  {options.description && (
                    <p className="mt-1.5 text-sm text-zinc-400 whitespace-pre-line">
                      {options.description}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 bg-white/[0.02] border-t border-white/5">
              <button
                onClick={() => resolve(false)}
                className={cn(
                  'px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors',
                  'text-zinc-300 hover:bg-white/5'
                )}
              >
                {options.cancelText ?? '取消'}
              </button>
              <button
                onClick={() => resolve(true)}
                autoFocus
                className={cn(
                  'px-3.5 py-1.5 rounded-md text-sm font-medium transition-all',
                  'text-white shadow-lg hover:brightness-110'
                )}
                style={{
                  backgroundColor: isDanger ? '#dc2626' : primaryColor,
                }}
              >
                {options.confirmText ?? '确定'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
