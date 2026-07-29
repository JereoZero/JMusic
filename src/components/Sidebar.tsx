import { Heart, Music, EyeOff, Settings, History, Keyboard } from 'lucide-react'
import { memo, useMemo } from 'react'
import type { ViewType } from '../types'
import { APP_CONFIG } from '../config'
import { THEMES } from '../config/themes'
import { useThemeStore } from '../stores/themeStore'
import { cn } from '../utils/cn'

interface SidebarProps {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  onToggleSettings: () => void
  onShowShortcuts?: () => void
  bgColor?: string
}

interface NavItemProps {
  icon: React.ElementType
  label: string
  active: boolean
  onClick: () => void
  primaryColor: string
}

// M11 修复：memo 包裹 NavItem，仅当自身 props 变化时重渲染
// 避免 Sidebar 因 bgColor 变化（切歌）导致所有 NavItem 重渲染
const NavItem = memo(function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  primaryColor,
}: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-3 rounded-xl',
        'transition-all duration-200 select-none',
        'hover:text-white',
        active ? 'font-semibold' : 'text-zinc-400 hover:bg-white/5'
      )}
      style={
        active
          ? {
              backgroundColor: `${primaryColor}18`,
              color: primaryColor,
            }
          : undefined
      }
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={22} strokeWidth={active ? 2.5 : 2} />
      <span className="text-[15px]">{label}</span>
      {active && (
        <div
          className="ml-auto w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: primaryColor }}
        />
      )}
    </button>
  )
})

const Sidebar = memo(function Sidebar({
  currentView,
  onViewChange,
  onToggleSettings,
  onShowShortcuts,
  bgColor,
}: SidebarProps) {
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  const navItems = useMemo(
    () => [
      { id: 'liked' as ViewType, icon: Heart, label: '我喜欢' },
      { id: 'history' as ViewType, icon: History, label: '播放历史' },
      { id: 'local' as ViewType, icon: Music, label: '本地音乐' },
      { id: 'hidden' as ViewType, icon: EyeOff, label: '已隐藏' },
    ],
    []
  )

  // M11 修复：预计算每个 nav item 的 onClick，引用稳定，配合 memo 避免重渲染
  const navClickHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {}
    for (const item of navItems) {
      handlers[item.id] = () => onViewChange(item.id)
    }
    return handlers
  }, [navItems, onViewChange])

  return (
    <div
      className="h-full flex flex-col p-3 w-48 transition-colors duration-300 select-none"
      style={{
        backgroundColor: bgColor || '#121212',
        transitionTimingFunction: 'cubic-bezier(0.33, 0, 0.67, 1)',
      }}
    >
      {/* Logo - 同时作为窗口拖动区域（macOS titleBarStyle=Overlay 时需要） */}
      <div className="flex items-center gap-3 px-3 py-5 mb-3" data-drag-region>
        <img
          src="/logo.png"
          alt="Jlocal"
          className="w-10 h-10 object-contain rounded-xl"
          draggable={false}
        />
        <div className="flex flex-col">
          <span className="text-lg font-bold text-white tracking-tight">Jlocal</span>
          <span className="text-xs text-zinc-500">{APP_CONFIG.version}</span>
        </div>
      </div>

      {/* 主导航 */}
      <nav className="space-y-0.5 mb-auto">
        {navItems.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={currentView === item.id}
            onClick={navClickHandlers[item.id]}
            primaryColor={primaryColor}
          />
        ))}
      </nav>

      {/* 底部操作区 */}
      <div className="pt-3 border-t border-white/5 space-y-0.5">
        {onShowShortcuts && (
          <button
            onClick={onShowShortcuts}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-3 rounded-xl',
              'transition-all duration-200 select-none',
              'text-zinc-400 hover:text-white hover:bg-white/5'
            )}
            aria-label="键盘快捷键"
            title="键盘快捷键 (⌘/)"
          >
            <Keyboard size={22} strokeWidth={2} />
            <span className="text-[15px]">快捷键</span>
          </button>
        )}
        <NavItem
          icon={Settings}
          label="设置"
          active={currentView === 'settings'}
          onClick={onToggleSettings}
          primaryColor={primaryColor}
        />
      </div>
    </div>
  )
})

export default Sidebar
