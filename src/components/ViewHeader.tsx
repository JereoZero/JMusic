import { memo, useCallback, ReactNode } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'
import { cn } from '../utils/cn'

interface ViewHeaderProps {
  title: string
  count?: number
  searchValue: string
  onSearchChange: (value: string) => void
  onRefresh?: () => void
  isLoading?: boolean
  searchPlaceholder?: string
  actions?: ReactNode
}

function ViewHeader({
  title,
  count,
  searchValue,
  onSearchChange,
  onRefresh,
  isLoading = false,
  searchPlaceholder = '搜索歌曲、歌手...',
  actions,
}: ViewHeaderProps) {
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  // M6 修复：稳定引用 + 移除多余的 boxShadow: undefined
  const handleSearchFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      e.currentTarget.style.borderColor = `${primaryColor}40`
    },
    [primaryColor]
  )
  const handleSearchBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'transparent'
  }, [])

  return (
    <div
      className="px-6 py-4 flex items-center justify-between border-b border-white/5"
      data-drag-region
    >
      <div className="flex items-end gap-4">
        <h2 className="text-2xl font-bold text-white tracking-tight">{title}</h2>
        {count !== undefined && (
          <span className="text-sm text-zinc-500 font-medium">{count} 首</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {actions}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className={cn(
              'p-2 rounded-full transition-all duration-200',
              'text-zinc-400 hover:text-white hover:bg-white/5',
              'active:scale-95 disabled:opacity-40'
            )}
            aria-label="刷新"
          >
            <RefreshCw size={18} className={cn(isLoading && 'animate-spin')} />
          </button>
        )}
        <div className="relative group">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors group-focus-within:text-zinc-300"
            size={16}
          />
          <input
            type="text"
            id="search-input"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="搜索歌曲"
            className={cn(
              'pl-10 pr-4 py-2 rounded-full text-sm w-64',
              'bg-white/5 text-white placeholder-zinc-600',
              'border border-transparent',
              'focus:outline-none focus:border-white/10 focus:bg-white/[0.07]',
              'transition-all duration-200'
            )}
            onFocus={handleSearchFocus}
            onBlur={handleSearchBlur}
          />
        </div>
      </div>
    </div>
  )
}

export default memo(ViewHeader)
