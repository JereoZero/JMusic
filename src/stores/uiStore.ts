import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 界面缩放档位：解决不同分辨率/DPI 下 UI 大小适配问题。
 * 实现方式：调整 <html> 的 font-size，Tailwind 的 rem 单位（text/padding/gap/尺寸）随之等比缩放；
 * 虚拟列表等少数 px 常量通过 factor 手动跟随，保证布局坐标系一致。
 */
export type UiScale = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge'

export interface UiScaleConfig {
  label: string
  description: string
  /** 应用到 document.documentElement 的 font-size（px），默认 16 */
  rootFontSize: number
  /** px 常量缩放因子 = rootFontSize / 16 */
  factor: number
}

export const UI_SCALE_CONFIG: Record<UiScale, UiScaleConfig> = {
  xsmall: { label: '极小', description: '0.6× 极紧凑', rootFontSize: 10, factor: 0.625 },
  small: { label: '紧凑', description: '0.8× 紧凑', rootFontSize: 13, factor: 0.8125 },
  medium: { label: '标准', description: '1.0× 默认', rootFontSize: 16, factor: 1 },
  large: { label: '放大', description: '1.25× 大', rootFontSize: 20, factor: 1.25 },
  xlarge: { label: '极大', description: '1.5× 最大', rootFontSize: 24, factor: 1.5 },
}

export const UI_SCALE_ORDER: UiScale[] = ['xsmall', 'small', 'medium', 'large', 'xlarge']

interface UiState {
  scale: UiScale
  setScale: (scale: UiScale) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      scale: 'medium',
      setScale: (scale) => set({ scale }),
    }),
    { name: 'ui-scale-storage' }
  )
)
