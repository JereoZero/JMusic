import { useState, useEffect, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'

interface ScanProgressEvent {
  phase: 'walking' | 'walking_done' | 'metadata'
  // walking 阶段：遍历目录
  scanned?: number
  supported?: number
  skipped?: number
  // metadata 阶段：读取元数据
  processed?: number
  total?: number
}

/**
 * 监听后端 scan_progress 事件，提供扫描进度状态。
 * 后端 scanner.rs 分两阶段 emit：
 * - walking: 遍历目录（每 200 文件）
 * - metadata: rayon 并行读取元数据（每 50 文件）
 */
export function useScanProgress() {
  const [progress, setProgress] = useState<ScanProgressEvent | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    listen<ScanProgressEvent>('scan_progress', (event) => {
      if (!cancelled) setProgress(event.payload)
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((e) => console.error('scan_progress listen failed:', e))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const reset = useCallback(() => {
    setProgress(null)
  }, [])

  // metadata 阶段有 total，可计算百分比；walking 阶段无 total
  const percent =
    progress?.phase === 'metadata' && progress.total && progress.total > 0
      ? Math.round(((progress.processed ?? 0) / progress.total) * 100)
      : 0

  const progressText = progress
    ? progress.phase === 'walking'
      ? `遍历目录中... 已扫描 ${progress.scanned ?? 0} 个文件`
      : progress.phase === 'walking_done'
        ? `目录遍历完成，准备读取元数据...`
        : `读取元数据... ${progress.processed ?? 0}/${progress.total ?? 0}`
    : null

  return { progress, progressText, percent, reset }
}
