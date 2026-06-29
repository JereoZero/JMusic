import { cn } from '../../utils/cn'

interface SettingCardProps {
  children: React.ReactNode
  className?: string
}

export function SettingCard({ children, className }: SettingCardProps) {
  // M5 修复：CSS 动画替代 motion.section，避免每张卡片注册独立 RAF 订阅
  return (
    <section
      className={cn(
        'animate-card-in rounded-xl border border-white/5 overflow-hidden',
        'bg-white/[0.02]',
        className
      )}
    >
      {children}
    </section>
  )
}
