import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../test/utils'
import Sidebar from '../Sidebar'
import type { ViewType } from '../../types'
import { APP_CONFIG } from '../../config'
import { useThemeStore } from '../../stores/themeStore'
import { THEMES } from '../../config/themes'

describe('Sidebar', () => {
  const defaultProps = {
    currentView: 'local' as ViewType,
    onViewChange: vi.fn(),
    onToggleSettings: vi.fn(),
  }

  it('应该正确渲染 Logo', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByText('Jlocal')).toBeInTheDocument()
    expect(screen.getByText(APP_CONFIG.version)).toBeInTheDocument()
  })

  it('应该渲染所有导航按钮', () => {
    render(<Sidebar {...defaultProps} />)
    // Sidebar 通过 aria-label 识别按钮（无障碍语义优先）
    expect(screen.getByRole('button', { name: '我喜欢' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '播放历史' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '本地音乐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已隐藏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
  })

  it('点击我喜欢应该调用 onViewChange', () => {
    render(<Sidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: '我喜欢' }))
    expect(defaultProps.onViewChange).toHaveBeenCalledWith('liked')
  })

  it('点击本地音乐应该调用 onViewChange', () => {
    render(<Sidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: '本地音乐' }))
    expect(defaultProps.onViewChange).toHaveBeenCalledWith('local')
  })

  it('点击设置应该调用 onToggleSettings', () => {
    render(<Sidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(defaultProps.onToggleSettings).toHaveBeenCalled()
  })

  it('当前选中的导航项应该有激活样式', () => {
    // 使用当前主题色构建期望，避免硬编码
    const primaryColor = THEMES[useThemeStore.getState().currentThemeId].primary
    render(<Sidebar {...defaultProps} currentView="liked" />)
    const likedButton = screen.getByRole('button', { name: '我喜欢' })
    // 组件用 `${primaryColor}18` 设置背景（18 hex = 9.4% alpha）
    expect(likedButton).toHaveStyle({
      backgroundColor: `${primaryColor}18`,
    })
  })
})
