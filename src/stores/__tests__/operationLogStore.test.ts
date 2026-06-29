import { describe, it, expect, beforeEach } from 'vitest'
import { useOperationLogStore } from '../operationLogStore'

describe('operationLogStore', () => {
  beforeEach(() => {
    useOperationLogStore.setState({ logs: [] })
  })

  describe('log', () => {
    it('should add log entry with action', () => {
      useOperationLogStore.getState().log('播放歌曲')
      const logs = useOperationLogStore.getState().logs
      expect(logs).toHaveLength(1)
      expect(logs[0].action).toBe('播放歌曲')
      expect(logs[0].timestamp).toBeTruthy()
      expect(logs[0].detail).toBeUndefined()
    })

    it('should add log entry with detail', () => {
      useOperationLogStore.getState().log('播放歌曲', '起风了')
      expect(useOperationLogStore.getState().logs[0].detail).toBe('起风了')
    })

    it('should add log entry with error', () => {
      useOperationLogStore.getState().log('播放失败', undefined, 'file not found')
      expect(useOperationLogStore.getState().logs[0].error).toBe('file not found')
    })

    it('should cap at 200 entries', () => {
      const store = useOperationLogStore.getState()
      for (let i = 0; i < 250; i++) {
        store.log(`action ${i}`)
      }
      expect(useOperationLogStore.getState().logs).toHaveLength(200)
      expect(useOperationLogStore.getState().logs[0].action).toBe('action 50')
      expect(useOperationLogStore.getState().logs[199].action).toBe('action 249')
    })
  })

  describe('clear', () => {
    it('should clear all logs', () => {
      useOperationLogStore.getState().log('test')
      useOperationLogStore.getState().log('test2')
      useOperationLogStore.getState().clear()
      expect(useOperationLogStore.getState().logs).toHaveLength(0)
    })
  })

  describe('getAll', () => {
    it('should format logs as strings', () => {
      const store = useOperationLogStore.getState()
      store.log('播放歌曲', '起风了')
      store.log('播放失败', undefined, 'timeout')

      const lines = store.getAll()
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('播放歌曲')
      expect(lines[0]).toContain('起风了')
      expect(lines[1]).toContain('播放失败')
      expect(lines[1]).toContain('timeout')
    })

    it('should include timestamp in each line', () => {
      useOperationLogStore.getState().log('test')
      const lines = useOperationLogStore.getState().getAll()
      const timeRegex = /^\[\d{2}:\d{2}:\d{2}\]/
      expect(lines[0]).toMatch(timeRegex)
    })

    it('should return empty array when no logs', () => {
      expect(useOperationLogStore.getState().getAll()).toHaveLength(0)
    })
  })

  describe('immutability', () => {
    it('getAll should not mutate internal state', () => {
      useOperationLogStore.getState().log('test')
      const before = useOperationLogStore.getState().logs.length
      useOperationLogStore.getState().getAll()
      expect(useOperationLogStore.getState().logs).toHaveLength(before)
    })
  })
})
