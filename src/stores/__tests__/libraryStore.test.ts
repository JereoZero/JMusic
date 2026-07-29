import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { Song } from '../../types'

vi.mock('../../api/backend-api', () => ({
  getSongs: vi.fn().mockResolvedValue([]),
  getLikedPaths: vi.fn().mockResolvedValue([]),
  getHiddenPaths: vi.fn().mockResolvedValue([]),
  toggleLike: vi.fn().mockResolvedValue(undefined),
  hideSong: vi.fn().mockResolvedValue(undefined),
  unhideSong: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../api/mock-api', () => ({
  mockApi: {
    getSongs: vi.fn().mockResolvedValue([]),
    getLikedPaths: vi.fn().mockResolvedValue([]),
    getHiddenPaths: vi.fn().mockResolvedValue([]),
    toggleLike: vi.fn().mockResolvedValue(undefined),
    hideSong: vi.fn().mockResolvedValue(undefined),
    unhideSong: vi.fn().mockResolvedValue(undefined),
  },
}))

// mock 底层 invoke，使 invokeApi 在 jsdom 环境下可被追踪
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const createMockSong = (overrides?: Partial<Song>): Song => ({
  id: 'test-id-1',
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

describe('libraryStore', () => {
  beforeEach(async () => {
    vi.resetModules()
    // 与 src/api/index.ts 的检测方式保持一致（__TAURI_INTERNALS__）
    ;(window as any).__TAURI_INTERNALS__ = true
  })

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应该有正确的初始状态', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const state = useLibraryStore.getState()
      expect(state.songs).toEqual([])
      expect(state.likedPaths).toBeInstanceOf(Set)
      expect(state.likedPaths.size).toBe(0)
      expect(state.hiddenPaths).toBeInstanceOf(Set)
      expect(state.hiddenPaths.size).toBe(0)
      // 初始即为加载中（App 启动即 fetchSongs），避免首帧闪现空状态
      expect(state.isLoading).toBe(true)
    })
  })

  describe('状态更新', () => {
    it('应该能够设置 songs', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const mockSongs = [createMockSong({ id: '1' }), createMockSong({ id: '2' })]

      useLibraryStore.setState({ songs: mockSongs })

      expect(useLibraryStore.getState().songs).toEqual(mockSongs)
    })

    it('应该能够设置 likedPaths', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const paths = new Set(['/music/song1.mp3', '/music/song2.mp3'])

      useLibraryStore.setState({ likedPaths: paths })

      expect(useLibraryStore.getState().likedPaths).toEqual(paths)
    })

    it('应该能够设置 hiddenPaths', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const paths = new Set(['/music/hidden1.mp3', '/music/hidden2.mp3'])

      useLibraryStore.setState({ hiddenPaths: paths })

      expect(useLibraryStore.getState().hiddenPaths).toEqual(paths)
    })

    it('应该能够设置 isLoading', async () => {
      const { useLibraryStore } = await import('../libraryStore')

      useLibraryStore.setState({ isLoading: true })
      expect(useLibraryStore.getState().isLoading).toBe(true)

      useLibraryStore.setState({ isLoading: false })
      expect(useLibraryStore.getState().isLoading).toBe(false)
    })
  })

  describe('Set 操作', () => {
    it('likedPaths 应该支持添加和删除', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const path = '/music/test.mp3'

      const newSet = new Set<string>()
      newSet.add(path)
      useLibraryStore.setState({ likedPaths: newSet })

      expect(useLibraryStore.getState().likedPaths.has(path)).toBe(true)

      newSet.delete(path)
      useLibraryStore.setState({ likedPaths: new Set(newSet) })

      expect(useLibraryStore.getState().likedPaths.has(path)).toBe(false)
    })

    it('hiddenPaths 应该支持添加和删除', async () => {
      const { useLibraryStore } = await import('../libraryStore')
      const path = '/music/test.mp3'

      const newSet = new Set<string>()
      newSet.add(path)
      useLibraryStore.setState({ hiddenPaths: newSet })

      expect(useLibraryStore.getState().hiddenPaths.has(path)).toBe(true)

      newSet.delete(path)
      useLibraryStore.setState({ hiddenPaths: new Set(newSet) })

      expect(useLibraryStore.getState().hiddenPaths.has(path)).toBe(false)
    })
  })

  describe('per-path 串行化并发保护', () => {
    it('同一 path 连续 toggleLike 应串行切换（非竞态）', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const invokeMock = vi.mocked(invoke)
      const likedArgs: boolean[] = []
      invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'toggle_like') {
          likedArgs.push((args as { liked: boolean } | undefined)?.liked as boolean)
        }
        // invokeApi 要求 data !== undefined，返回 null 通过校验
        return { success: true, data: null } as never
      })

      const { useLibraryStore } = await import('../libraryStore')
      const { toggleLike } = useLibraryStore.getState()
      const path = '/music/concurrent-test.mp3'

      // 并发发起 3 次同 path toggleLike
      await Promise.all([toggleLike(path), toggleLike(path), toggleLike(path)])

      // 串行执行：每次基于前一次结果切换 → true → false → true
      // 若无串行化（竞态）：3 次都基于初始 false，全为 true
      expect(likedArgs).toEqual([true, false, true])
    })

    it('不同 path 的 toggleLike 应并行执行（互不阻塞）', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const invokeMock = vi.mocked(invoke)
      let activeCount = 0
      let maxActive = 0
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'toggle_like') {
          activeCount++
          maxActive = Math.max(maxActive, activeCount)
          // 让出微任务，让其他 toggle_like 有机会并发进入
          await Promise.resolve()
          await Promise.resolve()
          activeCount--
        }
        return { success: true, data: null } as never
      })

      const { useLibraryStore } = await import('../libraryStore')
      const { toggleLike } = useLibraryStore.getState()

      // 不同 path 并发，应同时进入（maxActive > 1）
      await Promise.all([
        toggleLike('/music/a.mp3'),
        toggleLike('/music/b.mp3'),
        toggleLike('/music/c.mp3'),
      ])

      expect(maxActive).toBeGreaterThan(1)
    })

    it('同一 path 连续 toggleHidden 应串行切换（非竞态）', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const invokeMock = vi.mocked(invoke)
      const hiddenCmds: string[] = []
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'hide_song' || cmd === 'unhide_song') {
          hiddenCmds.push(cmd)
        }
        return { success: true, data: null } as never
      })

      const { useLibraryStore } = await import('../libraryStore')
      const { toggleHidden } = useLibraryStore.getState()
      const path = '/music/concurrent-hidden-test.mp3'

      // 并发发起 3 次同 path toggleHidden
      await Promise.all([toggleHidden(path), toggleHidden(path), toggleHidden(path)])

      // 串行执行：每次基于前一次结果切换 → hide → unhide → hide
      // 若无串行化（竞态）：3 次都基于初始 false，全为 hide
      expect(hiddenCmds).toEqual(['hide_song', 'unhide_song', 'hide_song'])
    })

    it('toggleHidden 同 path 并发时 hide/unhide 不并发（mutex 串行）', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const invokeMock = vi.mocked(invoke)
      let activeCount = 0
      let maxActive = 0
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'hide_song' || cmd === 'unhide_song') {
          activeCount++
          maxActive = Math.max(maxActive, activeCount)
          await Promise.resolve()
          await Promise.resolve()
          activeCount--
        }
        return { success: true, data: null } as never
      })

      const { useLibraryStore } = await import('../libraryStore')
      const { toggleHidden } = useLibraryStore.getState()

      // 同 path 并发：应串行（maxActive === 1）
      await Promise.all([toggleHidden('/music/x.mp3'), toggleHidden('/music/x.mp3')])

      expect(maxActive).toBe(1)
    })
  })
})
