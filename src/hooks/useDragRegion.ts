import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * 全局窗口拖动 hook（macOS titleBarStyle=Overlay 模式下使用）
 *
 * 原理：监听全局 mousedown，若点击的元素或其祖先标记了 `data-drag-region`，
 * 且不是交互元素（button/input/a 等），则调用 Tauri `startDragging()` API。
 *
 * 相比 `data-tauri-drag-region`（只在直接标记的元素上生效，不传递给子元素）
 * 和 `-webkit-app-region: drag`（在 Tauri WKWebView 中可能不工作），
 * 此方案通过 `closest()` 向上查找，子元素也能触发拖动，且交互元素自动排除。
 *
 * 用法：在需要拖动的元素上加 `data-drag-region` 属性即可。
 * 交互元素（button/input/a/select/textarea/[role="slider"]）自动排除，
 * 其他元素若需排除，加 `data-no-drag` 属性。
 */
export function useDragRegion() {
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      // 只响应左键
      if (e.button !== 0) return

      const target = e.target as HTMLElement | null
      if (!target) return

      // 向上查找是否有 data-drag-region 标记
      const dragRegion = target.closest('[data-drag-region]')
      if (!dragRegion) return

      // 排除交互元素：按钮/输入/链接/滑块/自定义排除
      const interactive = target.closest(
        'button, input, a, select, textarea, [role="slider"], [data-no-drag]'
      )
      if (interactive) return

      // 调用 Tauri 原生 startDragging API
      getCurrentWindow().startDragging().catch((err) => {
        console.error('[useDragRegion] startDragging failed:', err)
      })
    }

    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [])
}
