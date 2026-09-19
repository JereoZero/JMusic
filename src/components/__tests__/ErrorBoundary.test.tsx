import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '../../test/utils'
import ErrorBoundary from '../ErrorBoundary'

// 子组件是否抛错的开关（可变，便于验证「重试」后恢复正常）
const flag = { shouldThrow: true }

function Boom() {
  if (flag.shouldThrow) throw new Error('boom')
  return <div>内容正常</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    flag.shouldThrow = true
    // React 捕获错误时会向 console.error 输出堆栈，测试中静音
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('子组件正常时直接渲染 children', () => {
    flag.shouldThrow = false
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('内容正常')).toBeInTheDocument()
  })

  it('子组件抛错时渲染默认错误界面', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('出错了')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('fullScreen=false 时使用视图级文案且不占满整屏', () => {
    const { container } = render(
      <ErrorBoundary fullScreen={false}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('该视图渲染出错。可切换到其他页面，或点击重试。')).toBeInTheDocument()
    expect(container.firstChild).not.toHaveClass('min-h-screen')
  })

  it('支持自定义 title', () => {
    render(
      <ErrorBoundary title="页面加载出错">
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('页面加载出错')).toBeInTheDocument()
  })

  it('点击重试后恢复正常渲染', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('出错了')).toBeInTheDocument()

    flag.shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(screen.queryByText('出错了')).not.toBeInTheDocument()
    expect(screen.getByText('内容正常')).toBeInTheDocument()
  })

  it('传入 fallback 时优先渲染 fallback', () => {
    render(
      <ErrorBoundary fallback={<div>自定义兜底</div>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('自定义兜底')).toBeInTheDocument()
    expect(screen.queryByText('出错了')).not.toBeInTheDocument()
  })
})
