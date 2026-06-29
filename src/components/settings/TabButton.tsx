import { cn } from '../../utils/cn'

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  primaryColor: string
}

export function TabButton({ active, onClick, children, primaryColor }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
        active
          ? 'text-white'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
      )}
      style={
        active
          ? { backgroundColor: primaryColor }
          : undefined
      }
    >
      {children}
    </button>
  )
}
