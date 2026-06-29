import type { Song } from '../types'

interface Searchable {
  title: string | null
  artist: string | null
  album: string | null
}

export function filterSongs(songs: Song[], query: string): Song[] {
  if (!query.trim()) return songs

  const lowerQuery = query.toLowerCase()
  return songs.filter(
    (song) =>
      (song.title || '').toLowerCase().includes(lowerQuery) ||
      (song.artist || '').toLowerCase().includes(lowerQuery) ||
      (song.album || '').toLowerCase().includes(lowerQuery)
  )
}

export function filterByQuery<T extends Searchable>(items: T[], query: string): T[] {
  if (!query.trim()) return items

  const lowerQuery = query.toLowerCase()
  return items.filter(
    (item) =>
      (item.title || '').toLowerCase().includes(lowerQuery) ||
      (item.artist || '').toLowerCase().includes(lowerQuery) ||
      (item.album || '').toLowerCase().includes(lowerQuery)
  )
}
