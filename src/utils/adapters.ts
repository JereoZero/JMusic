import type { Song } from '../types'
import type { PlayHistory } from '../api'

export function playHistoryToSong(history: PlayHistory): Song {
  return {
    id: String(history.id),
    title: history.title || '未知标题',
    artist: history.artist || '未知歌手',
    album: history.album || '未知专辑',
    duration: history.duration || 0,
    path: history.path,
    cover: null,
    play_count: 0,
    created_at: history.played_at,
    is_liked: null,
  }
}

export function playHistoryListToSongs(histories: PlayHistory[]): Song[] {
  return histories.map(playHistoryToSong)
}
