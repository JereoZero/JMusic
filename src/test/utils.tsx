import React from 'react'
import { render as rtlRender, RenderOptions } from '@testing-library/react'
import { ReactElement } from 'react'

/**
 * 自定义 render 函数
 * 可以在这里添加全局的 Provider（如 ThemeProvider、Router 等）
 */
function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => {
    // 可以在这里添加全局 Provider
    return <>{children}</>
  }

  return rtlRender(ui, { wrapper: Wrapper, ...options })
}

// 重新导出 testing-library 的所有内容
export * from '@testing-library/react'

// 导出自定义的 render
export { render }
