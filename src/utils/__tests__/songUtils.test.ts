import { describe, it, expect } from 'vitest'
import { filterSongs, filterByQuery } from '../songUtils'
import type { Song } from '../../types'

const createSong = (overrides?: Partial<Song>): Song => ({
  id: '1',
  title: '测试歌曲',
  artist: '测试歌手',
  album: '测试专辑',
  duration: 200,
  path: '/music/test.mp3',
  cover: null,
  play_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  is_liked: null,
  ...overrides,
})

describe('filterSongs', () => {
  const songs = [
    createSong({ id: '1', title: '起风了', artist: '买辣椒也用券', album: '起风了' }),
    createSong({ id: '2', title: '晴天', artist: '周杰伦', album: '叶惠美' }),
    createSong({ id: '3', title: '七里香', artist: '周杰伦', album: '七里香' }),
    createSong({ id: '4', title: '夜曲', artist: '周杰伦', album: '十一月的肖邦' }),
  ]

  it('should return all songs when query is empty', () => {
    expect(filterSongs(songs, '')).toHaveLength(4)
    expect(filterSongs(songs, '   ')).toHaveLength(4)
  })

  it('should match by title', () => {
    const result = filterSongs(songs, '晴天')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('2')
  })

  it('should match by artist', () => {
    const result = filterSongs(songs, '周杰伦')
    expect(result).toHaveLength(3)
  })

  it('should match by album', () => {
    const result = filterSongs(songs, '叶惠美')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('2')
  })

  it('should be case insensitive', () => {
    const songsEn = [
      createSong({ id: '1', title: 'HELLO', artist: 'ADELE', album: '25' }),
      createSong({ id: '2', title: 'hello', artist: 'adele', album: '25' }),
    ]
    const result = filterSongs(songsEn, 'hello')
    expect(result).toHaveLength(2)
  })

  it('should match partial query', () => {
    const result = filterSongs(songs, '周')
    expect(result).toHaveLength(3)
  })

  it('should return empty array when no match', () => {
    const result = filterSongs(songs, '不存在歌曲')
    expect(result).toHaveLength(0)
  })

  it('should handle empty song list', () => {
    expect(filterSongs([], 'test')).toHaveLength(0)
  })
})

describe('filterByQuery', () => {
  const items = [
    { title: 'Song A', artist: 'Artist X', album: 'Album 1' },
    { title: 'Song B', artist: 'Artist Y', album: null },
    { title: null, artist: 'Artist Z', album: null },
    { title: null, artist: null, album: null },
  ]

  it('should handle missing fields gracefully', () => {
    const result = filterByQuery(items, 'Artist Z')
    expect(result).toHaveLength(1)
  })

  it('should return all when query is empty', () => {
    expect(filterByQuery(items, '')).toHaveLength(4)
  })

  it('empty items with empty query should return empty', () => {
    expect(filterByQuery([], '')).toHaveLength(0)
  })
})
