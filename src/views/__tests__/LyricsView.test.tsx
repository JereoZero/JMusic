import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '../../test/utils'
import LyricsView from '../LyricsView'
import type { Song } from '../../types'

const { mockSong } = vi.hoisted(() => ({
  mockSong: {
    id: '1',
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 180,
    path: '/test/song.mp3',
    play_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    cover: null,
    is_liked: null,
  } as Song,
}))

vi.mock('../../stores/playerStore', () => {
  const storeState = {
    currentSong: mockSong,
    currentTime: 0,
    isPlaying: true,
    seek: vi.fn(),
    togglePlay: vi.fn(),
  }
  // 模拟 Zustand store 的调用签名 + subscribe（LyricsView 用 store.subscribe 订阅 currentTime）
  const usePlayerStore = Object.assign(
    vi.fn((selector?: (s: typeof storeState) => unknown) => {
      return selector ? selector(storeState) : storeState
    }),
    {
      subscribe: vi.fn(() => vi.fn()),
      getState: () => storeState,
      setState: vi.fn(),
    }
  )
  return { usePlayerStore }
})

vi.mock('../../hooks/useSongCover', () => ({
  useSongCover: () => ({ cover: null, isLoading: false }),
}))

vi.mock('../../api/modules', () => ({
  getLyrics: vi.fn().mockResolvedValue(null),
}))

describe('LyricsView', () => {
  it('应该显示歌曲信息', async () => {
    render(<LyricsView onClose={() => {}} />)

    expect(screen.getByText('Test Song')).toBeInTheDocument()
    expect(screen.getByText(/专辑：.*Test Album/)).toBeInTheDocument()
    expect(screen.getByText(/歌手：.*Test Artist/)).toBeInTheDocument()

    // 等待异步歌词加载完成（mockApi 返回歌词内容），flush 状态更新避免 act() 警告
    await waitFor(() => {
      expect(screen.getByText('这是第一句歌词')).toBeInTheDocument()
    })
  })

  it('应该显示歌词加载状态', async () => {
    render(<LyricsView onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText(/加载歌词中|暂无歌词|这是第一句歌词/)).toBeInTheDocument()
    })
  })
})
