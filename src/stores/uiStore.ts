import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 界面缩放档位：解决不同分辨率/DPI 下 UI 大小适配问题。
 * 实现方式：调用 Tauri webview 原生缩放（`Webview.setZoom`，等价浏览器 Ctrl +/- 缩放），
 * 整个页面——包括 rem 与 px（lucide 图标、封面尺寸、内联 gap）——等比缩放，
 * 无需再逐处维护 px 常量，也不会出现「文字变大、图标不变」的错位。
 */
export type UiScale = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge'

export interface UiScaleConfig {
  label: string
  description: string
  /** webview 缩放倍率，直接传给 `Webview.setZoom` */
  zoom: number
}

export const UI_SCALE_CONFIG: Record<UiScale, UiScaleConfig> = {
  xsmall: { label: '极小', description: '0.6× 极紧凑', zoom: 0.625 },
  small: { label: '紧凑', description: '0.8× 紧凑', zoom: 0.8125 },
  medium: { label: '标准', description: '1.0× 默认', zoom: 1 },
  large: { label: '放大', description: '1.25× 大', zoom: 1.25 },
  xlarge: { label: '极大', description: '1.5× 最大', zoom: 1.5 },
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
