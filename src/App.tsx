import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { Toaster, toast } from 'sonner'
import { useHotkeys } from 'react-hotkeys-hook'
import Sidebar from './components/Sidebar'
import PlayerBar from './components/PlayerBar'
import AlertDialog from './components/AlertDialog'
import ShortcutsHelp from './components/ShortcutsHelp'
import ErrorBoundary from './components/ErrorBoundary'
import LikedView from './views/LikedView'
import { APP_CONFIG } from './config'
import { usePlayerStore, trackInitialLibraryLoad } from './stores/playerStore'
import { useLibraryStore } from './stores/libraryStore'
import { useCoverStore, initCoverStore } from './stores/coverStore'
import { useTheme } from './hooks/useTheme'
import * as api from './api/modules'
import { createErrorHandler } from './utils/errorHandler'
import { useDragRegion } from './hooks/useDragRegion'
import { useUiStore, UI_SCALE_CONFIG } from './stores/uiStore'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen } from '@tauri-apps/api/event'
import type { ViewType } from './types'

// 仅在实际切到对应视图/进入歌词页时才加载：
// LyricsView 依赖 lrc-file-parser，SettingsView 体积较大，都无需进首屏关键路径。
// 首屏默认渲染的 LikedView 保持静态引入，避免组件懒加载反而增加首屏开销。
const LocalView = lazy(() => import('./views/LocalView'))
const HiddenView = lazy(() => import('./views/HiddenView'))
const HistoryView = lazy(() => import('./views/HistoryView'))
const SettingsView = lazy(() => import('./views/SettingsView'))
const LyricsView = lazy(() => import('./views/LyricsView'))

// 懒加载视图的占位：沿用项目已有的居中 spinner 写法（见 LyricsView 的加载态）
function ViewLoadingFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex items-center gap-2 text-zinc-600">
        <div className="w-4 h-4 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm">加载中...</p>
      </div>
    </div>
  )
}

function AppContent() {
  const [currentView, setCurrentView] = useState<ViewType>('liked')
  const [previousView, setPreviousView] = useState<ViewType>('liked')
  const previousViewRef = useRef<ViewType>('liked')
  const [showLyrics, setShowLyrics] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

  // 界面缩放：webview 原生缩放，px/rem 全部等比跟随（等价浏览器 Ctrl +/-）
  const uiScale = useUiStore((s) => s.scale)
  useEffect(() => {
    getCurrentWebview()
      .setZoom(UI_SCALE_CONFIG[uiScale].zoom)
      .catch((e) => console.error('Failed to apply UI scale:', e))
  }, [uiScale])

  // 启用全局窗口拖动（macOS titleBarStyle=Overlay 模式）
  useDragRegion()

  // C6+C7 修复：移除 currentSong/volume 订阅，避免切歌/调音量整页重渲染
  const togglePlay = usePlayerStore((s) => s.togglePlay)
  const playNext = usePlayerStore((s) => s.playNext)
  const playPrev = usePlayerStore((s) => s.playPrev)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const seek = usePlayerStore((s) => s.seek)
  const initMediaSession = usePlayerStore((s) => s.initMediaSession)
  const restoreLastSong = usePlayerStore((s) => s.restoreLastSong)
  const initEventListeners = usePlayerStore((s) => s.initEventListeners)
  const cleanupEventListeners = usePlayerStore((s) => s.cleanupEventListeners)
  const fetchSongs = useLibraryStore((s) => s.fetchSongs)
  const fetchSongsAfterScan = useLibraryStore((s) => s.fetchSongsAfterScan)
  const fetchLikedPaths = useLibraryStore((s) => s.fetchLikedPaths)
  const fetchHiddenPaths = useLibraryStore((s) => s.fetchHiddenPaths)

  // C8 修复：订阅全局 coverStore 获取背景色，避免 4 处独立调用 useSongCover+useAlbumColor
  const mainBgColor = useCoverStore((s) => s.colors.main) ?? '#121212'
  const sidebarBgColor = useCoverStore((s) => s.colors.sidebar) ?? '#121212'

  // 初始化主题
  useTheme()

  // 初始化 coverStore（订阅 playerStore.currentSong 变化）
  useEffect(() => {
    initCoverStore()
  }, [])

  // 扫描完成通知：后端（启动时的自动扫描）在**写库完成后**广播 scan_complete。
  //
  // 为什么必须监听：启动扫描是后台异步任务，而下面的初始 fetchSongs 在空库时是
  // 毫秒级返回的，扫描却要走文件系统 + 提取元数据 —— 界面会一直停在「曲库为空」，
  // 用户只能手动下拉刷新或进设置重新扫描。
  //
  // 注册顺序有意放在初始 loadData **之前**：若扫描在本监听器注册前就已结束，
  // 说明数据早已落库，那次 fetchSongs 本身就能拿到完整数据，不存在漏更新的窗口。
  useEffect(() => {
    let cancelled = false
    let unlistenComplete: (() => void) | null = null
    let unlistenError: (() => void) | null = null

    listen('scan_complete', () => {
      if (!cancelled) void fetchSongsAfterScan()
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlistenComplete = fn
      })
      .catch((e) => console.error('scan_complete listen failed:', e))

    listen<{ message: string }>('scan_error', (event) => {
      if (!cancelled) toast.error(`扫描失败：${event.payload.message}`)
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlistenError = fn
      })
      .catch((e) => console.error('scan_error listen failed:', e))

    return () => {
      cancelled = true
      unlistenComplete?.()
      unlistenError?.()
    }
  }, [fetchSongsAfterScan])

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      // 登记整库加载 Promise：restoreLastSong 需要整库数据时会 await 同一个请求，
      // 避免冷启动时与这里并发、把全量歌曲拉两遍（库越大越明显）。
      const libraryLoad = Promise.all([fetchSongs(), fetchLikedPaths(), fetchHiddenPaths()])
      trackInitialLibraryLoad(libraryLoad)
      try {
        await libraryLoad
        if (!cancelled) toast('加载完成')
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : '初始化数据失败'
          toast.error(message)
        }
      }
    }
    loadData()
    return () => {
      cancelled = true
    }
  }, [fetchSongs, fetchLikedPaths, fetchHiddenPaths])

  useEffect(() => {
    let cancelled = false
    const initPlayer = async () => {
      initEventListeners()
      initMediaSession()
      await restoreLastSong()
      if (cancelled) return
    }
    initPlayer()

    const frontendVolume = usePlayerStore.getState().volume
    api.setVolume(frontendVolume).catch(createErrorHandler('启动音量同步'))

    return () => {
      cancelled = true
      cleanupEventListeners()
    }
  }, [initEventListeners, initMediaSession, restoreLastSong, cleanupEventListeners])

  useHotkeys(
    'space',
    () => {
      togglePlay()
    },
    { preventDefault: true, enableOnFormTags: false },
    [togglePlay]
  )

  useHotkeys('mod+left', () => playPrev(), { preventDefault: true, enableOnFormTags: false }, [
    playPrev,
  ])
  useHotkeys('mod+right', () => playNext(), { preventDefault: true, enableOnFormTags: false }, [
    playNext,
  ])

  // Cmd+F 聚焦当前视图的搜索框
  useHotkeys(
    'mod+f',
    (e) => {
      e.preventDefault()
      const searchInput = document.getElementById('search-input') as HTMLInputElement | null
      searchInput?.focus()
      searchInput?.select()
    },
    { enableOnFormTags: false }
  )

  // Cmd+? 或 Cmd+/ 打开快捷键帮助（表单中也应可用，macOS 系统约定）
  useHotkeys(
    'mod+/',
    (e) => {
      e.preventDefault()
      setShowShortcuts((v) => !v)
    },
    { enableOnFormTags: true }
  )

  // C24 修复：热键回调内读 store，依赖数组只保留 setter，避免切歌/调音量重绑监听
  useHotkeys(
    'left',
    () => {
      const { currentTime, currentSong } = usePlayerStore.getState()
      if (currentSong) seek(Math.max(0, currentTime - APP_CONFIG.player.seekStepSecs))
    },
    { preventDefault: true, enableOnFormTags: false },
    [seek]
  )

  useHotkeys(
    'right',
    () => {
      const { currentTime, duration, currentSong } = usePlayerStore.getState()
      if (currentSong) seek(Math.min(duration, currentTime + APP_CONFIG.player.seekStepSecs))
    },
    { preventDefault: true, enableOnFormTags: false },
    [seek]
  )

  useHotkeys(
    'up',
    () => {
      const v = usePlayerStore.getState().volume
      setVolume(Math.min(1, v + APP_CONFIG.player.volumeStep))
    },
    { preventDefault: true, enableOnFormTags: false },
    [setVolume]
  )
  useHotkeys(
    'down',
    () => {
      const v = usePlayerStore.getState().volume
      setVolume(Math.max(0, v - APP_CONFIG.player.volumeStep))
    },
    { preventDefault: true, enableOnFormTags: false },
    [setVolume]
  )

  const handleViewChange = useCallback((view: ViewType) => {
    setShowLyrics(false)
    if (view !== 'settings') {
      setPreviousView(view)
      previousViewRef.current = view
    }
    setCurrentView(view)
  }, [])

  // ESC：优先关闭歌词 → 退出设置 → 清空搜索
  useHotkeys(
    'esc',
    () => {
      if (showLyrics) {
        setShowLyrics(false)
        return
      }
      if (currentView === 'settings') {
        handleViewChange(previousViewRef.current)
        return
      }
      const searchInput = document.getElementById('search-input') as HTMLInputElement | null
      if (searchInput && searchInput.value) {
        searchInput.value = ''
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
        searchInput.blur()
      }
    },
    { enableOnFormTags: true },
    [showLyrics, currentView, handleViewChange]
  )

  const handleToggleSettings = useCallback(() => {
    setShowLyrics(false)
    setCurrentView((prev) => {
      if (prev === 'settings') {
        return previousViewRef.current
      } else {
        previousViewRef.current = prev
        setPreviousView(prev)
        return 'settings'
      }
    })
  }, [])

  const handleToggleLyrics = useCallback(() => {
    setShowLyrics((prev) => !prev)
  }, [])

  // #8 修复：useCallback 稳定引用，避免破坏 Sidebar memo
  const handleShowShortcuts = useCallback(() => {
    setShowShortcuts(true)
  }, [])

  const renderView = () => {
    if (showLyrics) {
      return <LyricsView onClose={handleToggleLyrics} />
    }

    switch (currentView) {
      case 'liked':
        return <LikedView />
      case 'history':
        return <HistoryView />
      case 'local':
        return <LocalView />
      case 'hidden':
        return <HiddenView />
      case 'settings':
        return <SettingsView onClose={() => setCurrentView(previousView)} />
      default:
        return <LikedView />
    }
  }

  return (
    <>
      {/* C13 修复：背景色独立 fixed 层，避免整页 repaint；降到 300ms 减少过渡时长 */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10 transition-colors duration-300"
        style={{
          backgroundColor: mainBgColor,
          transitionTimingFunction: 'cubic-bezier(0.33, 0, 0.67, 1)',
        }}
      />
      <div className="h-screen flex flex-col text-white overflow-hidden select-none">
        <div className="flex-1 flex overflow-hidden">
          <Sidebar
            currentView={currentView}
            onViewChange={handleViewChange}
            onToggleSettings={handleToggleSettings}
            onShowShortcuts={handleShowShortcuts}
            bgColor={sidebarBgColor}
          />
          <main className="flex-1 overflow-hidden">
            {/* 视图级错误隔离：单个视图崩溃不影响 Sidebar/PlayerBar，切视图自动重置 */}
            <ErrorBoundary
              key={showLyrics ? 'lyrics' : currentView}
              fullScreen={false}
              title="页面加载出错"
            >
              <Suspense fallback={<ViewLoadingFallback />}>{renderView()}</Suspense>
            </ErrorBoundary>
          </main>
        </div>

        <PlayerBar onToggleLyrics={handleToggleLyrics} />

        <AlertDialog />

        <ShortcutsHelp open={showShortcuts} onClose={() => setShowShortcuts(false)} />

        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              fontSize: '14px',
            },
          }}
        />
      </div>
    </>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  )
}

export default App
