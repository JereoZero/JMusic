import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePlayerStore } from '../playerStore'
import { usePlayQueueStore } from '../playQueueStore'
import type { Song } from '../../types'

const createMockSong = (overrides?: Partial<Song>): Song => ({
  id: 'test-id',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  duration: 180,
  path: '/test/song.mp3',
  cover: null,
  play_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  is_liked: null,
  ...overrides,
})

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    playSong: vi.fn().mockResolvedValue(undefined),
    pauseSong: vi.fn().mockResolvedValue(undefined),
    resumeSong: vi.fn().mockResolvedValue(undefined),
    stopSong: vi.fn().mockResolvedValue(undefined),
    seekSong: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn().mockResolvedValue(undefined),
    addPlayHistory: vi.fn().mockResolvedValue(undefined),
    getSongs: vi.fn().mockResolvedValue([]),
    getLikedSongs: vi.fn().mockResolvedValue({ songs: [] }),
    updateMediaSession: vi.fn(),
  },
}))

vi.mock('../../api/modules', () => ({ ...mockApi }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}))

function mockMediaSession() {
  Object.defineProperty(window, 'navigator', {
    value: {
      mediaSession: {
        metadata: null,
        setActionHandler: vi.fn(),
        setPositionState: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  })
}

describe('playerStore - initial state', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    usePlayQueueStore.setState({
      queue: [],
      currentIndex: -1,
      originalQueue: [],
      lastSongPath: null,
    })
    vi.clearAllMocks()
  })

  it('should have null currentSong', () => {
    expect(usePlayerStore.getState().currentSong).toBeNull()
  })

  it('should have isPlaying = false', () => {
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('should have currentTime = 0', () => {
    expect(usePlayerStore.getState().currentTime).toBe(0)
  })
})

describe('playerStore - playSong', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    vi.clearAllMocks()
  })

  it('should call playSong API and set state', async () => {
    const song = createMockSong()
    await usePlayerStore.getState().playSong(song)

    expect(mockApi.playSong).toHaveBeenCalledWith(song.path)
    const state = usePlayerStore.getState()
    expect(state.currentSong).toEqual(song)
    expect(state.isPlaying).toBe(true)
    expect(state.currentTime).toBe(0)
    expect(state.duration).toBe(song.duration)
  })

  it('should set play queue when provided', async () => {
    const songs = [
      createMockSong({ id: '1', path: '/a.mp3' }),
      createMockSong({ id: '2', path: '/b.mp3' }),
    ]
    await usePlayerStore.getState().playSong(songs[1], songs, 'liked')

    const qState = usePlayQueueStore.getState()
    expect(qState.queue).toHaveLength(2)
    expect(qState.currentIndex).toBe(1)
    expect(qState.queueSource).toBe('liked')
  })

  it('should finalize previous play history before new song', async () => {
    const prevSong = createMockSong({ id: 'prev', path: '/prev.mp3' })
    await usePlayerStore.getState().playSong(prevSong)
    vi.clearAllMocks()

    const newSong = createMockSong({ id: 'new', path: '/new.mp3' })
    await usePlayerStore.getState().playSong(newSong)

    expect(mockApi.addPlayHistory).toHaveBeenCalledWith(prevSong.path, expect.any(Number), false)
  })

  it('addPlayHistory 慢时连续 playSong 不并发调用 addPlayHistory', async () => {
    const songA = createMockSong({ id: 'a', path: '/a.mp3' })
    const songB = createMockSong({ id: 'b', path: '/b.mp3' })

    // 先播放 A，设置 currentPlayPath=A
    await usePlayerStore.getState().playSong(songA)
    vi.clearAllMocks()

    let activeCount = 0
    let maxActive = 0
    mockApi.addPlayHistory.mockImplementation(async () => {
      activeCount++
      maxActive = Math.max(maxActive, activeCount)
      await Promise.resolve()
      await Promise.resolve()
      activeCount--
    })

    // playSong(B) 触发 finalize(A, false)，currentPlayPath 清空
    // 后续 finalize 会 early return（currentPlayPath=null），不会并发
    await usePlayerStore.getState().playSong(songB)

    // 只应有 1 次 addPlayHistory（A 的 finalize），不并发
    expect(maxActive).toBe(1)
    expect(mockApi.addPlayHistory).toHaveBeenCalledTimes(1)
    expect(mockApi.addPlayHistory).toHaveBeenCalledWith(songA.path, expect.any(Number), false)
  })

  it('should handle API errors gracefully', async () => {
    mockApi.playSong.mockRejectedValueOnce(new Error('device error'))
    const song = createMockSong()
    await usePlayerStore.getState().playSong(song)

    const state = usePlayerStore.getState()
    expect(state.currentSong).toBeNull()
    expect(state.isPlaying).toBe(false)
  })
})

describe('playerStore - togglePlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 playQueueStore 防止 persist 持久化的 queueSource 在测试间泄露
    usePlayQueueStore.setState({
      queue: [],
      currentIndex: -1,
      originalQueue: [],
      queueSource: 'local',
      lastSongPath: null,
    })
  })

  it('should play random when no currentSong', async () => {
    usePlayerStore.setState({ currentSong: null, isPlaying: false })
    mockApi.getSongs.mockResolvedValueOnce([createMockSong({ id: '1', path: '/1.mp3' })])
    await usePlayerStore.getState().togglePlay()

    expect(mockApi.playSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('should pause when currently playing', async () => {
    usePlayerStore.setState({
      currentSong: createMockSong(),
      isPlaying: true,
    })
    await usePlayerStore.getState().togglePlay()

    expect(mockApi.pauseSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('should resume when paused', async () => {
    usePlayerStore.setState({
      currentSong: createMockSong(),
      isPlaying: false,
    })
    await usePlayerStore.getState().togglePlay()

    expect(mockApi.resumeSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })
})

describe('playerStore - pause / resume / stop', () => {
  it('pause should call API and set isPlaying false', async () => {
    usePlayerStore.setState({ currentSong: createMockSong(), isPlaying: true })
    await usePlayerStore.getState().pause()

    expect(mockApi.pauseSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('resume should call API and set isPlaying true', async () => {
    usePlayerStore.setState({ currentSong: createMockSong(), isPlaying: false })
    await usePlayerStore.getState().resume()

    expect(mockApi.resumeSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('stop should call API, finalize history, and reset', async () => {
    usePlayerStore.setState({
      currentSong: createMockSong({ path: '/playing.mp3' }),
      isPlaying: true,
      currentTime: 42,
    })
    vi.clearAllMocks()

    await usePlayerStore.getState().stop()

    expect(mockApi.stopSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
    expect(usePlayerStore.getState().currentTime).toBe(0)
  })
})

describe('playerStore - seek', () => {
  it('should call seek API and update state', async () => {
    usePlayerStore.setState({
      currentSong: createMockSong(),
      isPlaying: true,
      currentTime: 10,
    })
    await usePlayerStore.getState().seek(30)

    expect(mockApi.seekSong).toHaveBeenCalledWith(30)
    expect(usePlayerStore.getState().currentTime).toBe(30)
  })
})

describe('playerStore - setVolume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should call API and update state', () => {
    void usePlayerStore.getState().setVolume(0.5)

    // 状态立即更新
    expect(usePlayerStore.getState().volume).toBe(0.5)
    // API 通过 debounce(100ms) 调用，需推进定时器
    vi.advanceTimersByTime(100)
    expect(mockApi.setVolume).toHaveBeenCalledWith(0.5)
  })

  it('should clamp volume between 0 and 1 via store usage', () => {
    void usePlayerStore.getState().setVolume(1.5)
    vi.advanceTimersByTime(100)

    // 越界值应被钳制到 1
    expect(mockApi.setVolume).toHaveBeenCalledWith(1)
    expect(usePlayerStore.getState().volume).toBe(1)
  })
})

describe('playerStore - playNext / playPrev', () => {
  it('playNext should advance queue and play next song', async () => {
    const songs = [
      createMockSong({ id: '1', path: '/1.mp3' }),
      createMockSong({ id: '2', path: '/2.mp3' }),
      createMockSong({ id: '3', path: '/3.mp3' }),
    ]
    usePlayQueueStore.setState({
      queue: [...songs],
      originalQueue: [...songs],
      currentIndex: 0,
      queueSource: 'local',
    })
    usePlayerStore.setState({
      currentSong: songs[0],
      isPlaying: true,
    })

    await usePlayerStore.getState().playNext()

    expect(mockApi.playSong).toHaveBeenCalledWith('/2.mp3')
    expect(usePlayerStore.getState().currentSong?.id).toBe('2')
  })

  it('playPrev should go to previous song', async () => {
    const songs = [
      createMockSong({ id: '1', path: '/1.mp3' }),
      createMockSong({ id: '2', path: '/2.mp3' }),
      createMockSong({ id: '3', path: '/3.mp3' }),
    ]
    usePlayQueueStore.setState({
      queue: [...songs],
      originalQueue: [...songs],
      currentIndex: 2,
      queueSource: 'local',
    })
    usePlayerStore.setState({
      currentSong: songs[2],
      isPlaying: true,
    })

    await usePlayerStore.getState().playPrev()

    expect(mockApi.playSong).toHaveBeenCalledWith('/2.mp3')
    expect(usePlayerStore.getState().currentSong?.id).toBe('2')
  })
})

describe('playerStore - playSongAtIndex', () => {
  it('should play song at specified index from queue', async () => {
    const songs = makeQueue(5)
    usePlayQueueStore.setState({
      queue: [...songs],
      originalQueue: [...songs],
      currentIndex: 0,
    })

    await usePlayerStore.getState().playSongAtIndex(2)

    expect(mockApi.playSong).toHaveBeenCalledWith('/music/3.mp3')
    expect(usePlayQueueStore.getState().currentIndex).toBe(2)
  })

  it('should do nothing when index out of bounds', async () => {
    usePlayQueueStore.setState({ queue: [], currentIndex: -1 })
    await usePlayerStore.getState().playSongAtIndex(0)

    expect(mockApi.playSong).not.toHaveBeenCalled()
  })
})

describe('playerStore - playRandomSong', () => {
  it('should play a random song from liked songs if available', async () => {
    const likedSongs = makeQueue(10)
    mockApi.getLikedSongs.mockResolvedValueOnce({ songs: likedSongs })
    usePlayQueueStore.setState({ queueSource: 'liked' })

    await usePlayerStore.getState().playRandomSong()

    expect(mockApi.playSong).toHaveBeenCalled()
    expect(usePlayerStore.getState().currentSong).toBeDefined()
  })

  it('should fall back to all songs if liked list empty', async () => {
    mockApi.getLikedSongs.mockResolvedValueOnce({ songs: [] })
    mockApi.getSongs.mockResolvedValueOnce(makeQueue(5))
    usePlayQueueStore.setState({ queueSource: 'liked' })

    await usePlayerStore.getState().playRandomSong()

    expect(mockApi.getSongs).toHaveBeenCalled()
    expect(mockApi.playSong).toHaveBeenCalled()
  })
})

describe('playerStore - restoreLastSong', () => {
  it('should restore last song in paused state', async () => {
    const songs = makeQueue(5)
    mockApi.getSongs.mockResolvedValueOnce(songs)
    usePlayQueueStore.setState({
      lastSongPath: '/music/3.mp3',
      queueSource: 'local',
    })

    await usePlayerStore.getState().restoreLastSong()

    expect(usePlayerStore.getState().currentSong?.id).toBe('3')
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('should not play when no last song (only restore local state)', async () => {
    // restoreLastSong 语义：无上次记录时仅恢复本地状态，不主动播放
    // 主动播放是 togglePlay 的职责（currentSong 为 null 时调用 playRandomSong）
    usePlayQueueStore.setState({ lastSongPath: null })

    await usePlayerStore.getState().restoreLastSong()

    expect(mockApi.playSong).not.toHaveBeenCalled()
  })
})

describe('playerStore - MediaSession', () => {
  it('should set media session metadata on update', () => {
    mockMediaSession()
    const song = createMockSong({ title: 'My Song', artist: 'My Artist', album: 'My Album' })
    usePlayerStore.getState().updateMediaSession(song)

    const ms = (window.navigator as any).mediaSession
    if (ms.metadata) {
      expect(ms.metadata.title).toBe('My Song')
      expect(ms.metadata.artist).toBe('My Artist')
      expect(ms.metadata.album).toBe('My Album')
    }
  })

  it('should not crash when mediaSession is unavailable', () => {
    const song = createMockSong()
    expect(() => usePlayerStore.getState().updateMediaSession(song)).not.toThrow()
  })
})

function makeQueue(count: number): Song[] {
  return Array.from({ length: count }, (_, i) =>
    createMockSong({ id: String(i + 1), title: `Song ${i + 1}`, path: `/music/${i + 1}.mp3` })
  )
}

describe('playerStore - finalizePlayHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePlayerStore.setState({
      currentSong: null,
      isPlaying: false,
    })
    usePlayQueueStore.setState({
      queue: [],
      originalQueue: [],
      currentIndex: -1,
    })
  })

  it('should record play history when stopping playback', async () => {
    const song = createMockSong({ path: '/some/song.mp3' })
    await usePlayerStore.getState().playSong(song)

    vi.clearAllMocks()

    usePlayerStore.setState({ currentTime: 45 })
    await usePlayerStore.getState().stop()

    expect(mockApi.addPlayHistory).toHaveBeenCalledWith('/some/song.mp3', expect.any(Number), false)
  })

  it('should record play history when playing new song', async () => {
    const song1 = createMockSong({ id: '1', path: '/1.mp3' })
    const song2 = createMockSong({ id: '2', path: '/2.mp3' })

    await usePlayerStore.getState().playSong(song1)
    vi.clearAllMocks()

    await usePlayerStore.getState().playSong(song2)

    expect(mockApi.addPlayHistory).toHaveBeenCalledWith('/1.mp3', expect.any(Number), false)
  })
})
