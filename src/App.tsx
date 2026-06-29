import { useState, useEffect, useCallback, useRef } from 'react'
import { Toaster, toast } from 'sonner'
import { useHotkeys } from 'react-hotkeys-hook'
import Sidebar from './components/Sidebar'
import PlayerBar from './components/PlayerBar'
import AlertDialog from './components/AlertDialog'
import ShortcutsHelp from './components/ShortcutsHelp'
import ErrorBoundary from './components/ErrorBoundary'
import LocalView from './views/LocalView'
import LikedView from './views/LikedView'
import HiddenView from './views/HiddenView'
import HistoryView from './views/HistoryView'
import SettingsView from './views/SettingsView'
import LyricsView from './views/LyricsView'
import { APP_CONFIG } from './config'
import { usePlayerStore } from './stores/playerStore'
import { useLibraryStore } from './stores/libraryStore'
import { useCoverStore, initCoverStore } from './stores/coverStore'
import { useTheme } from './hooks/useTheme'
import * as api from './api/modules'
import { createErrorHandler } from './utils/errorHandler'
import { useDragRegion } from './hooks/useDragRegion'
import type { ViewType } from './types'

function AppContent() {
  const [currentView, setCurrentView] = useState<ViewType>('liked')
  const [previousView, setPreviousView] = useState<ViewType>('liked')
  const previousViewRef = useRef<ViewType>('liked')
  const [showLyrics, setShowLyrics] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

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

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      try {
        await Promise.all([fetchSongs(), fetchLikedPaths(), fetchHiddenPaths()])
        if (!cancelled) toast('加载完成')
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : '初始化数据失败'
          toast.error(message)
        }
      }
    }
    loadData()
    return () => { cancelled = true }
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
      if (currentSong) seek(Math.min(duration, currentTime + 5))
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
            {renderView()}
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
