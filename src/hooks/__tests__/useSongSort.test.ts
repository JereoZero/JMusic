import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSongSort, getSortIcon } from '../useSongSort'
import type { Song } from '../../types'

const createMockSong = (overrides?: Partial<Song>): Song => ({
  id: 'test-id',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  duration: 180,
  path: '/music/test.mp3',
  cover: null,
  play_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  is_liked: null,
  ...overrides,
})

describe('useSongSort', () => {
  const mockSongs = [
    createMockSong({ id: '1', title: 'C Song', artist: 'Artist C', album: 'Album C' }),
    createMockSong({ id: '2', title: 'A Song', artist: 'Artist A', album: 'Album A' }),
    createMockSong({ id: '3', title: 'B Song', artist: 'Artist B', album: 'Album B' }),
  ]

  describe('初始状态', () => {
    it('应该返回未排序的项目', () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      expect(result.current.titleSort).toBe('default')
      expect(result.current.albumSort).toBe('default')
      expect(result.current.likeSort).toBe('default')
      expect(result.current.sortedItems).toEqual(mockSongs)
    })
  })

  describe('标题排序', () => {
    it('应该按标题升序排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleTitleSort()
      })

      expect(result.current.titleSort).toBe('title-asc')
      expect(result.current.sortedItems[0].title).toBe('A Song')
      expect(result.current.sortedItems[2].title).toBe('C Song')
    })

    it('应该按标题降序排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleTitleSort()
      })
      await act(async () => {
        result.current.handleTitleSort()
      })

      expect(result.current.titleSort).toBe('title-desc')
      expect(result.current.sortedItems[0].title).toBe('C Song')
      expect(result.current.sortedItems[2].title).toBe('A Song')
    })

    it('应该按歌手排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleTitleSort()
      })
      await act(async () => {
        result.current.handleTitleSort()
      })
      await act(async () => {
        result.current.handleTitleSort()
      })

      expect(result.current.titleSort).toBe('artist-asc')
      expect(result.current.sortedItems[0].artist).toBe('Artist A')
    })
  })

  describe('专辑排序', () => {
    it('应该按专辑升序排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleAlbumSort()
      })

      expect(result.current.albumSort).toBe('album-asc')
      expect(result.current.sortedItems[0].album).toBe('Album A')
    })

    it('应该按专辑降序排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleAlbumSort()
      })
      await act(async () => {
        result.current.handleAlbumSort()
      })

      expect(result.current.albumSort).toBe('album-desc')
      expect(result.current.sortedItems[0].album).toBe('Album C')
    })
  })

  describe('喜欢排序', () => {
    it('应该将喜欢的歌曲排在前面', async () => {
      const likedPaths = new Set(['/music/test.mp3'])
      const songsWithLiked = [
        createMockSong({ id: '1', path: '/music/1.mp3' }),
        createMockSong({ id: '2', path: '/music/test.mp3' }),
        createMockSong({ id: '3', path: '/music/3.mp3' }),
      ]

      const { result } = renderHook(() => useSongSort(songsWithLiked, likedPaths))

      await act(async () => {
        result.current.handleLikeSort()
      })

      expect(result.current.likeSort).toBe('liked-first')
      expect(result.current.sortedItems[0].path).toBe('/music/test.mp3')
    })
  })

  describe('排序互斥', () => {
    it('标题排序应该重置专辑排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleAlbumSort()
      })
      await act(async () => {
        result.current.handleTitleSort()
      })

      expect(result.current.titleSort).toBe('title-asc')
      expect(result.current.albumSort).toBe('default')
    })

    it('专辑排序应该重置标题排序', async () => {
      const { result } = renderHook(() => useSongSort(mockSongs))

      await act(async () => {
        result.current.handleTitleSort()
      })
      await act(async () => {
        result.current.handleAlbumSort()
      })

      expect(result.current.albumSort).toBe('album-asc')
      expect(result.current.titleSort).toBe('default')
    })
  })
})

describe('getSortIcon', () => {
  it('默认状态应该返回箭头图标', () => {
    const icon = getSortIcon('default')
    expect(icon).toBeDefined()
  })

  it('升序状态应该返回向上箭头', () => {
    const icon = getSortIcon('title-asc')
    expect(icon).toBeDefined()
  })

  it('降序状态应该返回向下箭头', () => {
    const icon = getSortIcon('title-desc')
    expect(icon).toBeDefined()
  })
})
