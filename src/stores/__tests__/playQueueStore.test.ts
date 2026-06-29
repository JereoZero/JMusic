import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { usePlayQueueStore, usePlayerSettingsStore } from '../playQueueStore'
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

function makeQueue(count: number): Song[] {
  return Array.from({ length: count }, (_, i) =>
    createMockSong({ id: String(i + 1), title: `Song ${i + 1}`, path: `/music/${i + 1}.mp3` })
  )
}

function resetQueue(songs: Song[], index = 0) {
  usePlayQueueStore.setState({
    queue: [...songs],
    originalQueue: [...songs],
    currentIndex: index,
    queueSource: 'local',
    lastSongPath: null,
  })
}

describe('playerSettingsStore', () => {
  beforeEach(() => {
    usePlayerSettingsStore.setState({
      settings: { volume: 0.8, playMode: 'list' },
    })
  })

  it('setVolume should update volume', () => {
    usePlayerSettingsStore.getState().setVolume(0.5)
    expect(usePlayerSettingsStore.getState().settings.volume).toBe(0.5)
  })

  it('setPlayMode should cycle through modes', () => {
    const store = usePlayerSettingsStore
    store.getState().setPlayMode('shuffle')
    expect(store.getState().settings.playMode).toBe('shuffle')
    store.getState().setPlayMode('loop')
    expect(store.getState().settings.playMode).toBe('loop')
    store.getState().setPlayMode('list')
    expect(store.getState().settings.playMode).toBe('list')
  })
})

describe('playQueueStore - setQueue', () => {
  beforeEach(() => resetQueue([]))

  it('should set queue and reset originalQueue', () => {
    const songs = makeQueue(3)
    usePlayQueueStore.getState().setQueue(songs, 1, 'local')
    const state = usePlayQueueStore.getState()
    expect(state.queue).toEqual(songs)
    expect(state.originalQueue).toEqual(songs)
    expect(state.currentIndex).toBe(1)
    expect(state.queueSource).toBe('local')
  })
})

describe('playQueueStore - getCurrentSong', () => {
  it('should return song at currentIndex', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 1)
    expect(usePlayQueueStore.getState().getCurrentSong()?.id).toBe('2')
  })

  it('should return null when queue is empty', () => {
    resetQueue([])
    expect(usePlayQueueStore.getState().getCurrentSong()).toBeNull()
  })

  it('should return null when index out of bounds', () => {
    resetQueue(makeQueue(2), 5)
    expect(usePlayQueueStore.getState().getCurrentSong()).toBeNull()
  })
})

describe('playQueueStore - moveToNext', () => {
  it('should advance to next in list mode', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 0)
    const next = usePlayQueueStore.getState().moveToNext('list')
    expect(next?.id).toBe('2')
    expect(usePlayQueueStore.getState().currentIndex).toBe(1)
  })

  it('should wrap from last to first in list mode', () => {
    const songs = makeQueue(2)
    resetQueue(songs, 1)
    const next = usePlayQueueStore.getState().moveToNext('list')
    expect(next?.id).toBe('1')
  })

  it('should stay at current in loop mode', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 1)
    const next = usePlayQueueStore.getState().moveToNext('loop')
    expect(next?.id).toBe('2')
    expect(usePlayQueueStore.getState().currentIndex).toBe(1)
  })

  it('should return random song in shuffle mode', () => {
    const songs = makeQueue(10)
    resetQueue(songs, 3)
    const next = usePlayQueueStore.getState().moveToNext('shuffle')
    expect(next).toBeDefined()
    expect(next!.id).toBeDefined()
  })

  it('should return null when queue is empty', () => {
    resetQueue([])
    expect(usePlayQueueStore.getState().moveToNext('list')).toBeNull()
  })
})

describe('playQueueStore - moveToPrev', () => {
  it('should go to previous in list mode', () => {
    resetQueue(makeQueue(3), 2)
    const prev = usePlayQueueStore.getState().moveToPrev('list')
    expect(prev?.id).toBe('2')
  })

  it('should wrap from first to last in list mode', () => {
    resetQueue(makeQueue(2), 0)
    const prev = usePlayQueueStore.getState().moveToPrev('list')
    expect(prev?.id).toBe('2')
  })
})

describe('playQueueStore - addToQueue', () => {
  it('should append song to both queue and originalQueue', () => {
    resetQueue(makeQueue(2))
    const newSong = createMockSong({ id: '99', path: '/music/99.mp3' })
    usePlayQueueStore.getState().addToQueue(newSong)
    const state = usePlayQueueStore.getState()
    expect(state.queue).toHaveLength(3)
    expect(state.originalQueue).toHaveLength(3)
    expect(state.queue[2].id).toBe('99')
    expect(state.originalQueue[2].id).toBe('99')
  })
})

describe('playQueueStore - addToQueueNext', () => {
  it('should insert after current song', () => {
    const songs = makeQueue(4)
    resetQueue(songs, 1)
    const newSong = createMockSong({ id: '99', path: '/music/99.mp3' })
    usePlayQueueStore.getState().addToQueueNext(newSong)
    const state = usePlayQueueStore.getState()
    expect(state.queue[2].id).toBe('99')
  })
})

describe('playQueueStore - removeFromQueue', () => {
  it('should remove by index and adjust currentIndex', () => {
    const songs = makeQueue(5)
    resetQueue(songs, 2)
    usePlayQueueStore.getState().removeFromQueue(1)
    const state = usePlayQueueStore.getState()
    expect(state.queue).toHaveLength(4)
    expect(state.currentIndex).toBe(1)
  })

  it('should adjust currentIndex when removing current song', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 1)
    usePlayQueueStore.getState().removeFromQueue(1)
    const state = usePlayQueueStore.getState()
    expect(state.queue).toHaveLength(2)
    expect(state.currentIndex).toBe(1)
  })

  it('should update originalQueue by path', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 0)
    usePlayQueueStore.getState().removeFromQueue(1)
    const state = usePlayQueueStore.getState()
    expect(state.originalQueue).toHaveLength(2)
    expect(state.originalQueue[0].id).toBe('1')
    expect(state.originalQueue[1].id).toBe('3')
  })

  it('should not mutate state on invalid index', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 0)
    usePlayQueueStore.getState().removeFromQueue(99)
    expect(usePlayQueueStore.getState().queue).toHaveLength(3)
  })

  it('should work after shuffle (path-based removal)', () => {
    const songs = [
      createMockSong({ id: '1', path: '/a.mp3' }),
      createMockSong({ id: '2', path: '/b.mp3' }),
      createMockSong({ id: '3', path: '/c.mp3' }),
      createMockSong({ id: '4', path: '/d.mp3' }),
    ]
    resetQueue(songs, 0)
    usePlayQueueStore.getState().shuffleQueue()
    usePlayQueueStore.getState().removeFromQueue(0)
    const state = usePlayQueueStore.getState()
    expect(state.originalQueue).toHaveLength(3)
  })
})

describe('playQueueStore - clearQueue', () => {
  it('should clear both queue and originalQueue', () => {
    resetQueue(makeQueue(3), 1)
    usePlayQueueStore.getState().clearQueue()
    const state = usePlayQueueStore.getState()
    expect(state.queue).toHaveLength(0)
    expect(state.originalQueue).toHaveLength(0)
    expect(state.currentIndex).toBe(-1)
  })
})

describe('playQueueStore - moveInQueue', () => {
  it('should swap positions and track index', () => {
    const songs = makeQueue(5)
    resetQueue(songs, 2)
    usePlayQueueStore.getState().moveInQueue(1, 4)
    const state = usePlayQueueStore.getState()
    expect(state.queue[4].id).toBe('2')
    expect(state.currentIndex).toBe(1)
  })

  it('should update both queue and originalQueue', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 0)
    usePlayQueueStore.getState().moveInQueue(0, 2)
    const state = usePlayQueueStore.getState()
    expect(state.queue[2].id).toBe('1')
    expect(state.originalQueue[2].id).toBe('1')
  })

  it('should adjust currentIndex when moving current item', () => {
    const songs = makeQueue(3)
    resetQueue(songs, 0)
    usePlayQueueStore.getState().moveInQueue(0, 2)
    expect(usePlayQueueStore.getState().currentIndex).toBe(2)
  })

  it('should not change on invalid indices', () => {
    resetQueue(makeQueue(3), 0)
    usePlayQueueStore.getState().moveInQueue(-1, 0)
    expect(usePlayQueueStore.getState().queue).toHaveLength(3)
  })
})

describe('playQueueStore - shuffle/unshuffle', () => {
  it('should shuffle queue preserving current song position', () => {
    const songs = makeQueue(5)
    resetQueue(songs, 2)
    usePlayQueueStore.getState().shuffleQueue()
    const state = usePlayQueueStore.getState()
    expect(state.queue).toHaveLength(5)
    expect(state.originalQueue).toHaveLength(5)
    expect(state.queue[state.currentIndex].id).toBe('3')
  })

  it('unshuffle should restore original order', () => {
    const songs = makeQueue(5)
    resetQueue(songs, 2)
    usePlayQueueStore.getState().shuffleQueue()
    usePlayQueueStore.getState().unshuffleQueue()
    const state = usePlayQueueStore.getState()
    expect(state.queue.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(state.currentIndex).toBe(2)
  })

  it('shuffle on empty queue should not error', () => {
    resetQueue([])
    usePlayQueueStore.getState().shuffleQueue()
    expect(usePlayQueueStore.getState().queue).toHaveLength(0)
  })

  it('unshuffle on empty originalQueue should not error', () => {
    usePlayQueueStore.setState({ queue: [], originalQueue: [], currentIndex: -1 })
    usePlayQueueStore.getState().unshuffleQueue()
  })
})

describe('playQueueStore - setLastSongPath / setCurrentIndex', () => {
  it('setLastSongPath should update path', () => {
    usePlayQueueStore.getState().setLastSongPath('/test.mp3')
    expect(usePlayQueueStore.getState().lastSongPath).toBe('/test.mp3')
  })

  it('setLastSongPath should allow null', () => {
    usePlayQueueStore.getState().setLastSongPath('/test.mp3')
    usePlayQueueStore.getState().setLastSongPath(null)
    expect(usePlayQueueStore.getState().lastSongPath).toBeNull()
  })

  it('setCurrentIndex should update index', () => {
    usePlayQueueStore.getState().setCurrentIndex(3)
    expect(usePlayQueueStore.getState().currentIndex).toBe(3)
  })
})
