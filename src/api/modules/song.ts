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

export async function getThumbnailInfo(): Promise<ThumbnailInfo> {
  return await invokeApi<ThumbnailInfo>('get_thumbnail_info')
}
