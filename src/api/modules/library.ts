import { invokeApi } from './types'
import type { Song } from '../../types'

export async function getLikedPaths(): Promise<string[]> {
  return (await invokeApi<string[]>('get_liked_paths')) ?? []
}

export async function getLikedSongs(): Promise<{ songs: Song[] }> {
  const songs = (await invokeApi<Song[]>('get_liked_songs')) ?? []
  return { songs }
}

export async function toggleLike(path: string, liked: boolean): Promise<void> {
  await invokeApi<void>('toggle_like', { path, liked })
}

export async function clearLikedSongs(): Promise<number> {
  return (await invokeApi<number>('clear_liked_songs')) ?? 0
}

export async function isSongLiked(path: string): Promise<boolean> {
  return (await invokeApi<boolean>('is_song_liked', { path })) ?? false
}

// 隐藏
export async function hideSong(path: string, isAuto?: boolean): Promise<void> {
  await invokeApi<void>('hide_song', { path, isAuto })
}

export async function unhideSong(path: string): Promise<void> {
  await invokeApi<void>('unhide_song', { path })
}

export async function getHiddenPaths(): Promise<string[]> {
  return (await invokeApi<string[]>('get_hidden_paths')) ?? []
}

export async function getHiddenSongs(): Promise<Song[]> {
  return (await invokeApi<Song[]>('get_hidden_songs')) ?? []
}

export async function hideSongsBatch(paths: string[], isAuto?: boolean): Promise<number> {
  return (await invokeApi<number>('hide_songs_batch', { paths, isAuto })) ?? 0
}

export async function unhideSongsBatch(paths: string[]): Promise<number> {
  return (await invokeApi<number>('unhide_songs_batch', { paths })) ?? 0
}

export async function clearHiddenSongs(): Promise<number> {
  return (await invokeApi<number>('clear_hidden_songs')) ?? 0
}

export async function getHiddenCount(): Promise<number> {
  return (await invokeApi<number>('get_hidden_count')) ?? 0
}

export async function isSongHidden(path: string): Promise<boolean> {
  return (await invokeApi<boolean>('is_song_hidden', { path })) ?? false
}
