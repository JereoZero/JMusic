import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleError, createErrorHandler, AppError } from '../errorHandler'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

import { toast } from 'sonner'

describe('AppError', () => {
  it('should create error with name and code', () => {
    const err = new AppError('test message', 'E001')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
    expect(err.name).toBe('AppError')
    expect(err.message).toBe('test message')
    expect(err.code).toBe('E001')
  })

  it('should create error without code', () => {
    const err = new AppError('test message')
    expect(err.code).toBeUndefined()
  })
})

describe('handleError', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(toast.error).mockClear()
  })

  it('should log Error instance message and show toast', () => {
    handleError(new Error('network timeout'), '播放歌曲')
    expect(consoleSpy).toHaveBeenCalledWith('[播放歌曲]', expect.any(Error))
    expect(toast.error).toHaveBeenCalledWith('network timeout')
  })

  it('should handle non-Error objects with fallback message', () => {
    handleError('something went wrong', '扫描文件夹')
    expect(toast.error).toHaveBeenCalledWith('操作失败')
  })

  it('should handle null/undefined errors', () => {
    handleError(null, '测试')
    expect(toast.error).toHaveBeenCalledWith('操作失败')
  })
})

describe('createErrorHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(toast.error).mockClear()
  })

  it('should return a function that calls handleError with context', () => {
    const handler = createErrorHandler('恢复播放')
    handler(new Error('device busy'))
    expect(toast.error).toHaveBeenCalledWith('device busy')
  })
})
