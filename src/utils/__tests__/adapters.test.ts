import { describe, it, expect } from 'vitest'
import { playHistoryToSong, playHistoryListToSongs } from '../adapters'
import type { PlayHistory } from '../../api'

describe('adapters', () => {
  describe('playHistoryToSong', () => {
    it('应该正确转换完整的 PlayHistory 对象', () => {
      const history: PlayHistory = {
        id: 123,
        path: '/music/test.mp3',
        played_at: '2025-02-12T10:00:00Z',
        duration: 245,
        completed: 1,
        title: 'Test Song',
        artist: 'Test Artist',
        album: 'Test Album',
      }

      const song = playHistoryToSong(history)

      expect(song.id).toBe('123')
      expect(song.title).toBe('Test Song')
      expect(song.artist).toBe('Test Artist')
      expect(song.album).toBe('Test Album')
      expect(song.duration).toBe(245)
      expect(song.path).toBe('/music/test.mp3')
      expect(song.play_count).toBe(0)
      expect(song.created_at).toBe('2025-02-12T10:00:00Z')
    })

    it('应该处理缺失的可选字段', () => {
      const history: PlayHistory = {
        id: 1,
        path: '/music/unknown.mp3',
        played_at: '2025-02-12T10:00:00Z',
        duration: null,
        completed: null,
        title: null,
        artist: null,
        album: null,
      }

      const song = playHistoryToSong(history)

      expect(song.title).toBe('未知标题')
      expect(song.artist).toBe('未知歌手')
      expect(song.album).toBe('未知专辑')
      expect(song.duration).toBe(0)
    })

    it('应该将 number id 转换为 string', () => {
      const history: PlayHistory = {
        id: 999,
        path: '/music/test.mp3',
        played_at: '2025-02-12T10:00:00Z',
        duration: null,
        completed: null,
        title: null,
        artist: null,
        album: null,
      }

      const song = playHistoryToSong(history)

      expect(song.id).toBe('999')
      expect(typeof song.id).toBe('string')
    })
  })

  describe('playHistoryListToSongs', () => {
    it('应该正确转换数组', () => {
      const histories: PlayHistory[] = [
        {
          id: 1,
          path: '/music/song1.mp3',
          played_at: '2025-02-12T10:00:00Z',
          duration: null,
          completed: null,
          title: 'Song 1',
          artist: 'Artist 1',
          album: null,
        },
        {
          id: 2,
          path: '/music/song2.mp3',
          played_at: '2025-02-12T11:00:00Z',
          duration: null,
          completed: null,
          title: 'Song 2',
          artist: 'Artist 2',
          album: null,
        },
      ]

      const songs = playHistoryListToSongs(histories)

      expect(songs).toHaveLength(2)
      expect(songs[0].id).toBe('1')
      expect(songs[1].id).toBe('2')
    })

    it('应该返回空数组当输入为空', () => {
      const songs = playHistoryListToSongs([])
      expect(songs).toHaveLength(0)
    })
  })
})
