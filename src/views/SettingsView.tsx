import {
  X,
  Folder,
  Trash2,
  Info,
  RefreshCw,
  FileText,
  Copy,
  AlertCircle,
  CheckCircle,
  Edit2,
  Plus,
  Minus,
  Palette,
  Github,
  ExternalLink,
  Download,
  Sparkles,
} from 'lucide-react'
import { useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../api/modules'
import { useLibraryStore } from '../stores/libraryStore'
import { confirmDialog } from '../stores/dialogStore'
import { useOperationLogStore, type OperationLog } from '../stores/operationLogStore'
import { useThemeStore } from '../stores/themeStore'
import { THEMES, ThemeId } from '../config/themes'
import { useUpdateCheck, useScanProgress } from '../hooks'
import type { AppLog } from '../api/modules/types'
import { handleError } from '../utils/errorHandler'
import { APP_CONFIG } from '../config'
import { hexToRgba } from '../config/themes'
import { toast } from 'sonner'
import { cn } from '../utils/cn'
import { SettingCard, SettingRow, TabButton } from '../components/settings'
import { motion, AnimatePresence } from 'framer-motion'

interface SettingsViewProps {
  onClose: () => void
}

// 稳定的空数组引用，用于非 debug tab 时避免订阅 logs 触发重渲染
const EMPTY_LOGS: OperationLog[] = []

/** 版本历史数据（模块级常量，避免每次渲染重建 JSX） */
interface VersionEntry {
  version: string
  date: string
  changes: string[]
}

interface BriefVersionEntry {
  version: string
  description: string
}

const VERSION_HISTORY: VersionEntry[] = [
  {
    version: 'v0.9.0',
    date: '2026-06-27',
    changes: [
      'kira 0.12.1 替换 563 行手搓 player_thread，重构为 345 行（-438 行）',
      '新增 DsdDecoder 实现 kira Decoder trait，统一所有格式解码路径',
      'Phase 3 集成优化：修复 task 泄漏、play 竞态、track_finished UI 残留',
      'Phase 4 深度优化：N+1 查询消除、rayon 并行、colord/compare-versions 替换手搓',
      '删除 rodio 依赖，移除 flac_decoder.rs',
    ],
  },
  {
    version: 'v0.8.20',
    date: '2026-06-27',
    changes: [
      '深度审查修复 14 批 30+ 项 bug 与并发竞态',
      'player_thread 加 catch_unwind，toggleLike/toggleHidden per-path 串行化',
      '手搓 withPathLock/finalizePromise/useAlbumColor 缓存替换为成熟库',
      '前端 selector 切片、AbortController、cancelled flag 全面补齐',
    ],
  },
  {
    version: 'v0.8.19',
    date: '2026-06-24',
    changes: [
      'path_validator symlink TOCTOU 漏洞修复',
      '增量扫描（基于 file_mtime），跳过未变文件',
      'thumbnail 缓存 mtime 失效，文件替换后自动重新生成',
      '五阶段代码审查：类型系统/核心 bug/安全/测试/CI/CD',
    ],
  },
  {
    version: 'v0.8.18',
    date: '2026-06-24',
    changes: [
      'libraryStore fetchSongs 并发保护，playerStore destroy 补全历史保存',
      'useUpdateCheck GitHub API 缓存，invokeApi 超时机制',
      'thumbnail 滤镜优化（Lanczos3→Triangle），移除未使用依赖',
    ],
  },
  {
    version: 'v0.8.17',
    date: '2026-06-24',
    changes: [
      'filterSongs 空值保护，moveInQueue 拖拽 bug 修复',
      'SQLite PRAGMA 调优，upsert_songs 批量插入，scanner rayon 并行',
      'shouldSync 条件优化，搜索防抖统一',
    ],
  },
  {
    version: 'v0.8.16',
    date: '2026-06-23',
    changes: [
      'SongItem 移除 isPlaying prop，useAlbumColor 模块级缓存',
      'get_or_create_thumbnail 等 spawn_blocking 修复 async 阻塞',
      'useSongCover pendingRequests 分支 cleanup',
    ],
  },
  {
    version: 'v0.8.15',
    date: '2026-06-23',
    changes: [
      'ProgressBar 60fps 重渲染消除（subscribe + 100ms 节流）',
      'Sidebar navItems useMemo 稳定化',
      '后端 .ok()? 静默吞错改为 match + debug 日志',
    ],
  },
  {
    version: 'v0.8.14',
    date: '2026-06-23',
    changes: [
      'seek_song NaN/Infinity panic 防护，flac_decoder 除零保护',
      'LyricsView 60fps 重渲染消除，Store 订阅粒度优化',
      'add_log level 白名单，limit 非负校验',
    ],
  },
  {
    version: 'v0.8.13',
    date: '2026-06-23',
    changes: [
      'cleanup_nonexistent_songs 5N→2 次 DELETE，hide_songs_batch 批量化',
      '6 个 API 模块 || 误用为 ?? 修复',
      'useSongSort 类型守卫，除零保护',
    ],
  },
  {
    version: 'v0.8.12',
    date: '2026-06-22',
    changes: [
      'P0 find_fallback_cover 目录越权读取修复',
      '阻塞 I/O 全部迁移到 spawn_blocking',
      '7 个组件 60fps 全树重渲染修复',
      '统一 invokeApi 错误处理，15+ aria-label 无障碍改进',
    ],
  },
  {
    version: 'v0.8.11',
    date: '2026-05-28',
    changes: [
      '异步命令中的同步 I/O 改为 spawn_blocking，避免阻塞 tokio',
      'Tauri capabilities 权限收紧，仅保留核心权限',
      '修复未捕获的异步错误（初始化数据、恢复上次歌曲）',
      'LyricsView 歌词行计算 useCallback 改为 useMemo',
      '文档同步脚本路径修正 + 依赖安全更新',
    ],
  },
  {
    version: 'v0.8.10',
    date: '2026-05-28',
    changes: [
      '安全加固：4 项路径校验漏洞修复（二级文件夹、扫描、敏感目录）',
      '二级文件夹功能修复：恢复符号链接歌曲的访问',
      '喜欢/隐藏改为乐观更新，消除快速双击竞态',
      '音频流故障时前端状态自动同步',
      'HMR 热更新状态泄漏修复 + 死代码清理',
    ],
  },
  {
    version: 'v0.8.9',
    date: '2026-05-11',
    changes: [
      '封面批量请求逻辑修正：改用 DB 直接读取 music_folder',
      '批量隐藏安全加固：新增路径校验过滤越权路径',
      '元数据提取失败时不再用 "Unknown" 覆盖已有正确数据',
      'OutputStream 恢复时 Sink 追加预热（消除首次播放延迟）',
    ],
  },
  {
    version: 'v0.8.8',
    date: '2026-05-11',
    changes: [
      '检查更新 GitHub 地址修正 + 批量接口路径验证补充',
      'track_finished 竞态保护 + playRandomSong hidden 分支',
      'restoreLastSong 等待完成再初始化事件监听器',
    ],
  },
]

const BRIEF_VERSION_HISTORY: BriefVersionEntry[] = [
  { version: 'v0.8.3', description: '首次播放无声修复，原生 macOS 深色标题栏，窗口拖拽修复' },
  { version: 'v0.8.2', description: 'SineWave 预热音频管线，窗口拖拽三重保障' },
  { version: 'v0.8.1', description: 'macOS Overlay 暗色标题栏，后端防卡死' },
  { version: 'v0.8.0', description: '新 Logo + 霓虹绿主题，Fisher-Yates 随机播放' },
]

export default function SettingsView({ onClose }: SettingsViewProps) {
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'general' | 'logs' | 'debug'>('general')
  const [logs, setLogs] = useState<AppLog[]>([])
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'error'>('all')
  const [musicFolder, setMusicFolder] = useState<string>('')
  const [secondaryFolders, setSecondaryFolders] = useState<string[]>([])
  const fetchSongs = useLibraryStore((s) => s.fetchSongs)
  const fetchSongsAfterScan = useLibraryStore((s) => s.fetchSongsAfterScan)
  const fetchLikedPaths = useLibraryStore((s) => s.fetchLikedPaths)
  const fetchHiddenPaths = useLibraryStore((s) => s.fetchHiddenPaths)
  // 仅在 debug tab 时订阅操作日志，避免每次 log() 触发 SettingsView 重渲染
  const operationLogs = useOperationLogStore((s) =>
    activeTab === 'debug' ? s.logs : EMPTY_LOGS
  )
  const clearOperationLogs = useOperationLogStore((s) => s.clear)
  const currentThemeId = useThemeStore((s) => s.currentThemeId)
  const setTheme = useThemeStore((s) => s.setTheme)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)
  const { updateInfo, isChecking, error: updateError, checkUpdate, clearUpdateInfo } = useUpdateCheck()
  const { progressText, percent, reset: resetScanProgress } = useScanProgress()

  // unmount 守卫：async handler 在 await 完成后若组件已卸载，跳过 setState/reset
  // React 18+ 虽不再打印 warning，但显式守卫可避免无意义的渲染与 store 操作
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  // 统一的 async handler 收尾：unmount 后无操作
  const finishLoading = useCallback(
    (resetScan: boolean = false) => {
      if (!mountedRef.current) return
      setLoading(false)
      if (resetScan) resetScanProgress()
    },
    [resetScanProgress]
  )

  useEffect(() => {
    let cancelled = false
    const loadSettings = async () => {
      try {
        const [primaryFolder, secondary] = await Promise.all([
          api.getPrimaryMusicFolder(),
          api.getSecondaryFolders(),
        ])
        if (cancelled) return
        setMusicFolder(primaryFolder)
        setSecondaryFolders(secondary.map((s) => s.target))
      } catch (error) {
        if (cancelled) return
        handleError(error, '加载设置')
      }
    }
    loadSettings()
    return () => { cancelled = true }
  }, [])

  // 统一的日志加载函数：刷新按钮和 useEffect 共用
  // signal 用于在 useEffect cleanup 时丢弃过期响应
  const loadLogs = useCallback(async (signal?: AbortSignal) => {
    try {
      const level = logFilter === 'all' ? undefined : logFilter.toUpperCase()
      const data = await api.getLogs(level, APP_CONFIG.ui.logFetchLimit)
      if (signal?.aborted) return
      setLogs(data)
    } catch (error) {
      if (signal?.aborted) return
      handleError(error, '加载日志')
    }
  }, [logFilter])

  useEffect(() => {
    if (activeTab !== 'logs') return
    const controller = new AbortController()
    void loadLogs(controller.signal)
    return () => { controller.abort() }
  }, [activeTab, loadLogs])

  const handleCopyLogs = async () => {
    try {
      const text = await api.getLogsAsText()
      await navigator.clipboard.writeText(text)
      toast.success('日志已复制到剪贴板')
    } catch (error) {
      toast.error('复制失败')
      handleError(error, '复制日志')
    }
  }

  const handleClearLogs = async () => {
    if (!(await confirmDialog({ title: '清空所有日志？', variant: 'danger', confirmText: '清空' }))) return
    setLoading(true)
    try {
      const count = await api.clearLogs()
      toast.success(`已清空 ${count} 条日志`)
      await loadLogs()
    } catch (error) {
      toast.error('清空失败')
      handleError(error, '清空日志')
    } finally {
      finishLoading()
    }
  }

  const getLogIcon = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error':
        return <AlertCircle size={14} className="text-red-400" />
      default:
        return <CheckCircle size={14} className="text-blue-400" />
    }
  }

  const getLogColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error':
        return 'text-red-400'
      default:
        return 'text-blue-400'
    }
  }

  const handleClearPlayHistory = async () => {
    if (!(await confirmDialog({ title: '清空播放历史？', variant: 'danger', confirmText: '清空' }))) return
    setLoading(true)
    try {
      await api.clearPlayHistory()
      toast.success('已清空播放历史')
    } catch (error) {
      toast.error('清空失败')
      handleError(error, '清空历史')
    } finally {
      finishLoading()
    }
  }

  /** 格式化扫描结果消息：显示新增/更新数 + 跳过未变数 */
  const formatScanMessage = (prefix: string, result: { normal_songs: unknown[]; encrypted_songs: unknown[]; skipped?: number }) => {
    const total = result.normal_songs.length + result.encrypted_songs.length
    const skipped = result.skipped || 0
    if (skipped > 0) {
      return `${prefix}新增/更新 ${total} 首，跳过 ${skipped} 首未变`
    }
    return `${prefix}发现 ${total} 首歌曲`
  }

  const handleClearAllData = async () => {
    if (!(await confirmDialog({
      title: '清除全部历史数据？',
      description: '这将清空播放历史、喜欢列表、隐藏列表、操作日志。\n此操作不可恢复！',
      variant: 'danger',
      confirmText: '清除全部',
    }))) return
    setLoading(true)
    try {
      await api.clearPlayHistory()
      await api.clearLikedSongs()
      await api.clearHiddenSongs()
      clearOperationLogs()
      await fetchLikedPaths()
      await fetchHiddenPaths()
      await fetchSongs()
      const result = await api.scanFolder(musicFolder)
      toast.success(formatScanMessage('已清除全部历史数据，重新扫描', result))
      await fetchSongsAfterScan()
    } catch (error) {
      toast.error('清除失败')
      handleError(error, '清除全部数据')
    } finally {
      finishLoading(true)
    }
  }

  const handleClearHiddenSongs = async () => {
    if (!(await confirmDialog({ title: '清空隐藏列表？', variant: 'danger', confirmText: '清空' }))) return
    setLoading(true)
    try {
      const count = await api.clearHiddenSongs()
      toast.success(`已清空 ${count} 首隐藏歌曲`)
      await fetchHiddenPaths()
      await fetchSongs()
    } catch (error) {
      toast.error('清空失败')
      handleError(error, '清空隐藏列表')
    } finally {
      finishLoading()
    }
  }

  const copyDebugLogs = () => {
    const logs = useOperationLogStore.getState().getAll()
    navigator.clipboard
      .writeText(logs.join('\n'))
      .then(() => toast.success('操作日志已复制'))
      .catch((e) => {
        toast.error('复制失败')
        handleError(e, '复制操作日志')
      })
  }

  const clearDebugLogs = () => {
    clearOperationLogs()
  }

  const handleSelectPrimaryFolder = async () => {
    setLoading(true)
    try {
      const selected = await api.selectFolder()
      if (selected) {
        setMusicFolder(selected)
        await api.setSetting('music_folder', selected)
        const result = await api.scanFolder(selected)
        toast.success(formatScanMessage('主文件夹已更新，', result))
        await fetchSongsAfterScan()
      }
    } catch (error) {
      toast.error('选择文件夹失败')
      handleError(error, '选择主文件夹')
    } finally {
      finishLoading(true)
    }
  }

  const handleAddSecondaryFolder = async () => {
    setLoading(true)
    try {
      const selected = await api.selectFolder()
      if (selected) {
        await api.addSecondaryFolder(selected)
        setSecondaryFolders((prev) => [...prev, selected])
        toast.success('已添加副文件夹')
        const result = await api.scanFolder(musicFolder)
        toast.success(formatScanMessage('扫描完成！', result))
        await fetchSongsAfterScan()
      }
    } catch (error) {
      toast.error('选择文件夹失败')
      handleError(error, '选择二级文件夹')
    } finally {
      finishLoading(true)
    }
  }

  const handleRemoveSecondaryFolder = async (index: number) => {
    if (!(await confirmDialog({
      title: '删除这个副文件夹？',
      description: '歌曲会从列表中移除，但不会删除文件。',
      variant: 'danger',
      confirmText: '删除',
    }))) return
    setLoading(true)
    try {
      const secondary = await api.getSecondaryFolders()
      const folderToRemove = secondaryFolders[index]
      if (!folderToRemove) {
        toast.error('未找到指定的副文件夹')
        return
      }
      const linkInfo = secondary.find((s) => s.target === folderToRemove)
      if (linkInfo) {
        await api.removeSecondaryFolder(linkInfo.name)
        setSecondaryFolders((prev) => prev.filter((_, i) => i !== index))
        const result = await api.scanFolder(musicFolder)
        toast.success(formatScanMessage('已删除副文件夹，扫描完成！', result))
        await fetchSongsAfterScan()
      }
    } catch (error) {
      toast.error('删除失败')
      handleError(error, '删除副文件夹')
    } finally {
      finishLoading(true)
    }
  }

  const handleRescan = async () => {
    setLoading(true)
    try {
      const result = await api.scanFolder(musicFolder)
      toast.success(formatScanMessage('扫描完成！', result))
      await fetchSongsAfterScan()
    } catch (error) {
      toast.error('扫描失败')
      handleError(error, '重新扫描')
    } finally {
      finishLoading(true)
    }
  }

  const sectionTitleClass = 'text-lg font-semibold text-white mb-4 flex items-center gap-2'
  const buttonPrimaryClass = cn(
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white',
    'transition-all duration-200 hover:brightness-110 active:scale-95'
  )
  const buttonSecondaryClass = cn(
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium',
    'bg-white/5 text-white hover:bg-white/10 transition-all duration-200 active:scale-95'
  )
  const buttonDangerClass = cn(
    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200',
    'bg-red-500/10 text-red-400 hover:bg-red-500/20 active:scale-95'
  )

  return (
    <div className="h-full flex flex-col select-none">
      {/* 头部 */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-white/5" data-drag-region>
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold text-white tracking-tight">设置</h2>
          <div className="flex gap-2">
            <TabButton active={activeTab === 'general'} onClick={() => setActiveTab('general')} primaryColor={primaryColor}>
              通用
            </TabButton>
            <TabButton active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} primaryColor={primaryColor}>
              日志
            </TabButton>
            <TabButton active={activeTab === 'debug'} onClick={() => setActiveTab('debug')} primaryColor={primaryColor}>
              调试
            </TabButton>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-all duration-200 hover:scale-110 active:scale-90"
          aria-label="关闭设置"
        >
          <X size={20} />
        </button>
      </div>

      {/* 设置内容 */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-2xl space-y-6">
          <AnimatePresence mode="wait">
            {activeTab === 'general' && (
              <motion.div
                key="general"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-6"
              >
                {/* 音乐文件夹 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Folder size={20} style={{ color: primaryColor }} />
                      音乐文件夹
                    </h3>
                    <div className="space-y-3">
                      <SettingRow title={musicFolder || '未设置'} description="主音乐文件夹">
                        <span
                          className="text-xs px-2 py-1 rounded-md font-medium"
                          style={{
                            backgroundColor: hexToRgba(primaryColor, 0.15),
                            color: primaryColor,
                          }}
                        >
                          当前使用
                        </span>
                      </SettingRow>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button onClick={handleSelectPrimaryFolder} className={buttonPrimaryClass} style={{ backgroundColor: primaryColor }}>
                        <Edit2 size={14} />
                        更改主文件夹
                      </button>
                      <button onClick={handleRescan} disabled={loading} className={buttonSecondaryClass}>
                        <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
                        重新扫描
                      </button>
                    </div>
                    {loading && progressText && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
                        <RefreshCw size={12} className="animate-spin" style={{ color: primaryColor }} />
                        <span>{progressText}</span>
                        {percent > 0 && <span className="text-zinc-500">({percent}%)</span>}
                      </div>
                    )}
                  </div>
                </SettingCard>

                {/* 主题色 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Palette size={20} style={{ color: THEMES[currentThemeId].primary }} />
                      主题色
                    </h3>
                    <div className="grid grid-cols-4 gap-3">
                      {(Object.keys(THEMES) as ThemeId[]).map((id) => {
                        const theme = THEMES[id]
                        const isSelected = currentThemeId === id
                        return (
                          <button
                            key={id}
                            onClick={() => setTheme(id)}
                            className={cn(
                              'p-3 rounded-xl border-2 transition-all duration-200 hover:scale-[1.03] active:scale-[0.97]',
                              isSelected
                                ? 'border-white/20 bg-white/5'
                                : 'border-transparent bg-white/[0.03] hover:bg-white/5'
                            )}
                          >
                            <div
                              className="w-8 h-8 rounded-full mx-auto mb-2 ring-2 ring-white/10"
                              style={{ backgroundColor: theme.primary }}
                            />
                            <p className={cn('text-xs text-center', isSelected ? 'text-white font-medium' : 'text-zinc-500')}>
                              {theme.name}
                            </p>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </SettingCard>

                {/* 副文件夹 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Folder size={20} className="text-blue-400" />
                      副文件夹
                    </h3>
                    <p className="text-xs text-zinc-600 mb-4">添加额外的音乐文件夹，歌曲会合并到本地音乐中</p>
                    <div className="space-y-3">
                      {secondaryFolders.map((folder, index) => (
                        <SettingRow key={folder} title={folder} description={`副文件夹 ${index + 1}`}>
                          <button
                            onClick={() => handleRemoveSecondaryFolder(index)}
                            disabled={loading}
                            className={cn(buttonDangerClass, 'p-2 hover:scale-105 active:scale-95')}
                          >
                            <Minus size={16} />
                          </button>
                        </SettingRow>
                      ))}
                      <button
                        onClick={handleAddSecondaryFolder}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white/[0.03] hover:bg-white/5 rounded-lg transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] text-sm text-zinc-500 border border-white/5 border-dashed"
                      >
                        <Plus size={16} />
                        添加副文件夹
                      </button>
                    </div>
                  </div>
                </SettingCard>

                {/* 数据管理 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Trash2 size={20} className="text-red-400" />
                      数据管理
                    </h3>
                    <div className="space-y-3">
                      <SettingRow title="播放历史" description="清空所有播放记录">
                        <button onClick={handleClearPlayHistory} disabled={loading} className={buttonDangerClass}>
                          清空
                        </button>
                      </SettingRow>
                      <SettingRow title="隐藏列表" description="恢复所有隐藏的歌曲">
                        <button onClick={handleClearHiddenSongs} disabled={loading} className={buttonDangerClass}>
                          清空
                        </button>
                      </SettingRow>
                    </div>
                  </div>
                </SettingCard>

                {/* 关于 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Info size={20} className="text-blue-400" />
                      关于
                    </h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex gap-2">
                        <span className="text-zinc-600 w-20">应用名称</span>
                        <span className="text-white font-medium">JlocalMusic</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-zinc-600 w-20">版本</span>
                        <span className="text-white">v{APP_CONFIG.version}</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-zinc-600 w-20">技术栈</span>
                        <span className="text-white">Rust + Tauri 2 + React 19</span>
                      </div>

                      {/* 项目地址 */}
                      <div className="pt-2">
                        <a
                          href={APP_CONFIG.repository}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-all text-sm"
                        >
                          <Github size={16} />
                          <span>GitHub 项目主页</span>
                          <ExternalLink size={12} />
                        </a>
                      </div>

                      {/* 检查更新 */}
                      <div className="pt-1">
                        {!updateInfo ? (
                          <button
                            onClick={() => checkUpdate(true)}
                            disabled={isChecking}
                            className={cn(
                              'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all',
                              'bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white'
                            )}
                          >
                            <RefreshCw size={16} className={cn(isChecking && 'animate-spin')} />
                            {isChecking ? '检查中...' : '检查更新'}
                          </button>
                        ) : updateInfo.hasUpdate ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-sm">
                              <Sparkles size={16} className="text-yellow-400" />
                              <span className="text-white">
                                发现新版本 v{updateInfo.latestVersion}
                              </span>
                              <span className="text-zinc-600">
                                (当前 v{updateInfo.currentVersion})
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <a
                                href={updateInfo.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn(
                                  'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white',
                                  'transition-all duration-200 hover:brightness-110 active:scale-95'
                                )}
                                style={{ backgroundColor: primaryColor }}
                              >
                                <Download size={16} />
                                前往下载
                              </a>
                              <button
                                onClick={clearUpdateInfo}
                                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 bg-white/5 hover:bg-white/10 transition-all"
                              >
                                忽略
                              </button>
                            </div>
                            {updateInfo.publishedAt && (
                              <p className="text-xs text-zinc-600">
                                发布于 {new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-zinc-500">
                            <CheckCircle size={16} className="text-green-400" />
                            <span>已是最新版本 v{updateInfo.currentVersion}</span>
                            <button
                              onClick={clearUpdateInfo}
                              className="text-xs text-zinc-600 hover:text-zinc-400 ml-2"
                            >
                              重新检查
                            </button>
                          </div>
                        )}
                        {updateError && (
                          <p className="text-xs text-red-400 mt-1">{updateError}</p>
                        )}
                      </div>

                      <p className="text-zinc-600 pt-2">本地音乐播放器，支持 MP3、FLAC、WAV 等格式。</p>
                    </div>
                  </div>
                </SettingCard>

                {/* 版本历史 */}
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <FileText size={20} className="text-green-400" />
                      版本历史
                    </h3>
                    <div className="space-y-4 text-sm max-h-80 overflow-y-auto">
                      {VERSION_HISTORY.map((entry) => (
                        <div
                          key={entry.version}
                          className="border-l-2 pl-4"
                          style={{ borderLeftColor: primaryColor }}
                        >
                          <p className="text-white font-medium">{entry.version}</p>
                          <p className="text-xs text-zinc-600 mb-2">{entry.date}</p>
                          <ul className="space-y-1 text-zinc-500">
                            {entry.changes.map((change, i) => (
                              <li key={i}>{change}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {BRIEF_VERSION_HISTORY.map((entry) => (
                        <div key={entry.version} className="border-l-2 border-zinc-800 pl-3">
                          <span className="text-zinc-500 text-xs">{entry.version}</span>
                          <span className="text-zinc-700 text-xs ml-2">— {entry.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </SettingCard>
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div
                key="logs"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-6"
              >
                <SettingCard>
                  <div className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className={sectionTitleClass}>
                        <FileText size={20} className="text-blue-400" />
                        日志管理
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={handleCopyLogs} className={buttonSecondaryClass}>
                          <Copy size={14} />
                          复制
                        </button>
                        <button onClick={() => loadLogs()} className={buttonSecondaryClass}>
                          <RefreshCw size={14} />
                          刷新
                        </button>
                        <button onClick={handleClearLogs} disabled={loading} className={buttonDangerClass}>
                          <Trash2 size={14} />
                          清空
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-2 mb-4">
                      {(['all', 'info', 'error'] as const).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => setLogFilter(filter)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200',
                            logFilter === filter
                              ? 'text-white'
                              : 'bg-white/5 text-zinc-500 hover:text-zinc-300'
                          )}
                          style={logFilter === filter ? { backgroundColor: primaryColor } : undefined}
                        >
                          {filter === 'all' ? '全部' : filter === 'info' ? '信息' : '错误'}
                        </button>
                      ))}
                    </div>
                    <div className="bg-black/30 rounded-xl p-4 max-h-96 overflow-y-auto border border-white/5">
                      {logs.length === 0 ? (
                        <div className="text-center py-8 text-zinc-600">暂无日志</div>
                      ) : (
                        <div className="space-y-2">
                          {logs.map((log) => (
                            <div key={log.id} className="flex items-start gap-3 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                              <div className="mt-0.5">{getLogIcon(log.level)}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={cn('text-xs font-medium', getLogColor(log.level))}>{log.level}</span>
                                  <span className="text-xs text-zinc-600">{new Date(log.created_at).toLocaleString('zh-CN')}</span>
                                </div>
                                <p className="text-sm text-zinc-400 break-words">{log.message}</p>
                                {log.target && <p className="text-xs text-zinc-600 mt-1">目标: {log.target}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </SettingCard>
              </motion.div>
            )}

            {activeTab === 'debug' && (
              <motion.div
                key="debug"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-6"
              >
                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <Trash2 size={20} className="text-red-400" />
                      数据清除
                    </h3>
                    <p className="text-xs text-zinc-600 mb-4">清除所有历史数据，包括播放历史、喜欢列表、隐藏列表等</p>
                    <div className="space-y-3">
                      <SettingRow title="清除全部历史数据" description="清空播放历史、喜欢列表、隐藏列表、操作日志">
                        <button onClick={handleClearAllData} disabled={loading} className={cn(buttonDangerClass, 'bg-red-500 hover:bg-red-600 text-white')}>
                          清除全部
                        </button>
                      </SettingRow>
                      <SettingRow title="仅清除播放历史" description="保留喜欢列表和隐藏列表">
                        <button onClick={handleClearPlayHistory} disabled={loading} className={buttonDangerClass}>
                          清除
                        </button>
                      </SettingRow>
                    </div>
                  </div>
                </SettingCard>

                <SettingCard>
                  <div className="p-6">
                    <h3 className={sectionTitleClass}>
                      <AlertCircle size={20} className="text-yellow-400" />
                      操作日志
                    </h3>
                    <p className="text-xs text-zinc-600 mb-4">记录用户操作和后台执行情况，便于排查问题</p>
                    <div className="bg-black/30 rounded-xl p-4 max-h-96 overflow-y-auto border border-white/5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-zinc-500">日志记录</span>
                        <div className="flex gap-2">
                          <button onClick={copyDebugLogs} className="text-xs px-2 py-1 bg-white/5 rounded hover:bg-white/10 text-zinc-500 transition-colors">
                            复制
                          </button>
                          <button onClick={clearDebugLogs} className="text-xs px-2 py-1 bg-white/5 rounded hover:bg-white/10 text-zinc-500 transition-colors">
                            清空
                          </button>
                        </div>
                      </div>
                      {operationLogs.length === 0 ? (
                        <div className="text-center py-4 text-zinc-600 text-sm">暂无操作记录</div>
                      ) : (
                        <div className="space-y-1 font-mono text-xs">
                          {operationLogs.map((log, index) => (
                            <div key={index} className="text-zinc-500">
                              [{log.timestamp}] {log.action}
                              {log.detail ? ` - ${log.detail}` : ''}
                              {log.error ? ` [错误: ${log.error}]` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </SettingCard>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
