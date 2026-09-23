import { invokeApi } from './types'
import type { ScanFolderResult, ThumbnailInfo } from './types'
import type { Song } from '../../types'

export async function getSongs(): Promise<Song[]> {
  return (await invokeApi<Song[]>('get_songs')) ?? []
}

/** 获取最后播放的歌曲（restoreLastSong 后端兜底） */
export async function getLastPlayedSong(): Promise<Song | null> {
  return (await invokeApi<Song | null>('get_last_played_song')) ?? null
}

export async function searchSongs(query: string): Promise<Song[]> {
  return (await invokeApi<Song[]>('search_songs', { query })) ?? []
}

export async function scanFolder(path: string): Promise<ScanFolderResult> {
  // 扫描可能耗时较长（大音乐库），使用 5 分钟超时
  return await invokeApi<ScanFolderResult>('scan_folder', { path }, 300_000)
}

export async function deleteSong(path: string): Promise<void> {
  await invokeApi<void>('delete_song', { path })
}

export async function getSongCoverLarge(path: string): Promise<string | null> {
  return (await invokeApi<string | null>('get_song_cover_large', { path })) ?? null
}

/**
 * 获取 56px 的小缩略图（列表行内用）。
 *
 * 行内图标只有 40×40，用 `getSongCoverLarge`（200px）会多传 4-8 倍数据、
 * 多解码 12.7 倍像素。列表场景请优先用 [`getSongCoversBatch`] 合并成一次 IPC。
 */
export async function getSongCover(path: string): Promise<string | null> {
  return (await invokeApi<string | null>('get_song_cover', { path })) ?? null
}

/**
 * 批量获取 56px 小缩略图：一次 IPC 取多张，替代逐行请求。
 *
 * 后端单次上限 100（超出会被拒绝），调用方需自行分片。
 * 返回的 map 只包含后端有封面且已生成成功缩略图的路径。
 */
export async function getSongCoversBatch(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const data =
    (await invokeApi<Record<string, string | null>>('get_song_covers_batch', { paths })) ?? {}
  // 过滤掉 null（后端会对「无封面」的路径返回 null 占位）
  const result: Record<string, string> = {}
  for (const [path, cover] of Object.entries(data)) {
    if (cover) result[path] = cover
  }
  return result
}

export async function getThumbnailInfo(): Promise<ThumbnailInfo> {
  return await invokeApi<ThumbnailInfo>('get_thumbnail_info')
}
