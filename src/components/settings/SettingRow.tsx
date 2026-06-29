import { cn } from '../../utils/cn'

interface SettingRowProps {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}

export function SettingRow({ title, description, children, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between p-4',
        'bg-white/[0.03] rounded-lg',
        'border border-white/5',
        className
      )}
    >
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-sm font-medium text-white">{title}</p>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}
