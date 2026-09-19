import { Component, type ReactNode } from 'react'
import { getPrimaryColor } from '../stores/themeStore'
import { cn } from '../utils/cn'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /**
   * 是否占满整屏。
   * - `true`（默认）：应用级兜底，Sidebar/PlayerBar 一并被替换
   * - `false`：视图级隔离，仅替换出错视图的内容区，Sidebar/PlayerBar 保持可用
   */
  fullScreen?: boolean
  title?: string
  description?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const { fullScreen = true } = this.props
      const title = this.props.title ?? '出错了'
      const description =
        this.props.description ??
        (fullScreen
          ? '应用遇到了一个错误。请尝试刷新页面。'
          : '该视图渲染出错。可切换到其他页面，或点击重试。')

      const primaryColor = getPrimaryColor()

      return (
        <div
          className={cn(
            'flex items-center justify-center p-4',
            fullScreen ? 'min-h-screen bg-[#121212]' : 'h-full w-full'
          )}
        >
          <div className="bg-[#1a1a1a] rounded-lg p-6 max-w-md w-full text-center">
            <div className="text-red-500 mb-4">
              <svg
                className="w-16 h-16 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">{title}</h2>
            <p className="text-zinc-400 mb-4">{description}</p>
            {this.state.error && (
              <pre className="text-xs text-zinc-500 bg-[#0a0a0a] p-2 rounded mb-4 overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 text-white rounded-lg transition-colors"
                style={{ backgroundColor: primaryColor }}
              >
                重试
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-[#2a2a2a] text-white rounded-lg hover:bg-[#3a3a3a] transition-colors"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
