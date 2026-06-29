import { invoke } from '@tauri-apps/api/core'
import type { Song } from '../../types'

export type { Song }

// 从 ts-rs 自动生成的类型重新导出（与后端 Rust 结构体保持一致）
// 运行 `npm run gen:types` 重新生成
export type { AppLog } from '../../types/generated/AppLog'
export type { Metadata } from '../../types/generated/Metadata'
export type { PlayHistory } from '../../types/generated/PlayHistory'
export type { PlaybackState } from '../../types/generated/PlaybackState'

// 后端播放器状态（重命名为 BackendPlayerState 避免与 UI 层 PlayerState 冲突）
import type { PlayerState as BackendPlayerState } from '../../types/generated/PlayerState'
export type { BackendPlayerState }

// 扫描结果（后端名为 ScanResult，前端别名 ScanFolderResult 保持兼容）
import type { ScanResult } from '../../types/generated/ScanResult'
export type ScanFolderResult = ScanResult

// 以下为前端独有类型，后端无对应结构体
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface LyricSource {
  type: 'embedded' | 'external'
  content: string
}

export interface ThumbnailInfo {
  small_count: number
  large_count: number
  size_bytes: number
}

/**
 * 统一的 invoke 封装：自动处理 ApiResponse 的 success 校验和错误抛出。
 * 消除各模块中重复的 `if (!response.success) throw new Error(response.error)` 模式。
 * 内置 15 秒超时，防止后端卡住时前端永久等待。长耗时操作可传入更大 timeout。
 */
const DEFAULT_INVOKE_TIMEOUT_MS = 15_000

export async function invokeApi<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS
): Promise<T> {
  // 保存 timer id，Promise resolve 后 clearTimeout 清理，避免每次成功调用残留定时器
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      invoke<ApiResponse<T>>(cmd, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`操作超时: ${cmd} (${timeoutMs / 1000}s)`)),
          timeoutMs
        )
      }),
    ])
    if (!response.success) {
      throw new Error(response.error || `操作失败: ${cmd} 返回未知错误`)
    }
    if (response.data === undefined) {
      throw new Error(`操作失败: ${cmd} 返回数据为空`)
    }
    return response.data
  } finally {
    if (timer) clearTimeout(timer)
  }
}
