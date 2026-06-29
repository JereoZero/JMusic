import { invokeApi } from './types'
import type { AppLog, PlayHistory, LyricSource } from './types'

// 日志
export async function addLog(level: string, message: string, target?: string): Promise<void> {
  await invokeApi<void>('add_log', { level, message, target })
}

export async function getLogs(level?: string, limit?: number): Promise<AppLog[]> {
  return (await invokeApi<AppLog[]>('get_logs', { level, limit })) ?? []
}

export async function getErrorLogs(): Promise<AppLog[]> {
  return (await invokeApi<AppLog[]>('get_error_logs')) ?? []
}

export async function clearLogs(): Promise<number> {
  return (await invokeApi<number>('clear_logs')) ?? 0
}

export async function getLogCount(): Promise<number> {
  return (await invokeApi<number>('get_log_count')) ?? 0
}

export async function getLogsAsText(): Promise<string> {
  return (await invokeApi<string>('get_logs_as_text')) ?? ''
}

// 播放历史
export async function addPlayHistory(
  path: string,
  duration: number,
  completed: boolean
): Promise<void> {
  await invokeApi<void>('add_play_history', { path, duration, completed })
}

export async function getPlayHistory(limit?: number): Promise<PlayHistory[]> {
  return (await invokeApi<PlayHistory[]>('get_play_history', { limit })) ?? []
}

export async function clearPlayHistory(): Promise<void> {
  await invokeApi<void>('clear_play_history')
}

export async function getPlayCounts(): Promise<Record<string, number>> {
  const data = (await invokeApi<Array<[string, number]>>('get_play_counts')) ?? []
  return Object.fromEntries(data)
}

export async function getSongPlayCount(path: string): Promise<number> {
  return (await invokeApi<number>('get_song_play_count', { path })) ?? 0
}

// 歌词
export async function getLyrics(path: string): Promise<LyricSource | null> {
  return (await invokeApi<LyricSource | null>('get_lyrics', { path })) ?? null
}
