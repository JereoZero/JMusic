import { describe, it, expect } from 'vitest'
import { formatDuration, formatFileSize, formatDate, formatDateTime, truncate } from '../format'

describe('formatDuration', () => {
  describe('基本功能', () => {
    it('应该正确格式化 0 秒', () => {
      expect(formatDuration(0)).toBe('0:00')
    })

    it('应该正确格式化小于 1 分钟的秒数', () => {
      expect(formatDuration(1)).toBe('0:01')
      expect(formatDuration(30)).toBe('0:30')
      expect(formatDuration(59)).toBe('0:59')
    })

    it('应该正确格式化整分钟', () => {
      expect(formatDuration(60)).toBe('1:00')
      expect(formatDuration(120)).toBe('2:00')
      expect(formatDuration(300)).toBe('5:00')
    })

    it('应该正确格式化分钟和秒', () => {
      expect(formatDuration(90)).toBe('1:30')
      expect(formatDuration(185)).toBe('3:05')
      expect(formatDuration(3661)).toBe('1:01:01')
    })
  })

  describe('边界情况', () => {
    it('应该正确处理超过 1 小时的时长', () => {
      expect(formatDuration(3600)).toBe('1:00:00')
      expect(formatDuration(3661)).toBe('1:01:01')
      expect(formatDuration(7325)).toBe('2:02:05')
    })

    it('应该正确处理浮点数', () => {
      expect(formatDuration(90.5)).toBe('1:30')
      expect(formatDuration(185.9)).toBe('3:05')
    })

    it('应该正确处理负数', () => {
      expect(formatDuration(-1)).toBe('0:00')
      expect(formatDuration(-100)).toBe('0:00')
    })

    it('应该正确处理非数字', () => {
      expect(formatDuration(NaN)).toBe('0:00')
      expect(formatDuration(Infinity)).toBe('0:00')
    })
  })
})

describe('formatFileSize', () => {
  describe('基本功能', () => {
    it('应该正确格式化 0 字节', () => {
      expect(formatFileSize(0)).toBe('0 B')
    })

    it('应该正确格式化字节', () => {
      expect(formatFileSize(100)).toBe('100 B')
      expect(formatFileSize(512)).toBe('512 B')
    })

    it('应该正确格式化 KB', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB')
      expect(formatFileSize(2048)).toBe('2.0 KB')
      expect(formatFileSize(1536)).toBe('1.5 KB')
    })

    it('应该正确格式化 MB', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
      expect(formatFileSize(1024 * 1024 * 5)).toBe('5.0 MB')
    })

    it('应该正确格式化 GB', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB')
      expect(formatFileSize(1024 * 1024 * 1024 * 10)).toBe('10.0 GB')
    })
  })

  describe('边界情况', () => {
    it('应该正确处理负数', () => {
      expect(formatFileSize(-1)).toBe('0 B')
    })

    it('应该正确处理非数字', () => {
      expect(formatFileSize(NaN)).toBe('0 B')
      expect(formatFileSize(Infinity)).toBe('0 B')
    })
  })
})

describe('formatDate', () => {
  it('应该正确格式化日期字符串', () => {
    const result = formatDate('2024-01-15')
    expect(result).toContain('2024')
  })

  it('应该正确格式化 Date 对象', () => {
    const date = new Date(2024, 0, 15)
    const result = formatDate(date)
    expect(result).toContain('2024')
  })

  it('应该处理无效日期', () => {
    expect(formatDate('invalid')).toBe('')
    expect(formatDate(new Date('invalid'))).toBe('')
  })
})

describe('formatDateTime', () => {
  it('应该正确格式化日期时间', () => {
    const date = new Date(2024, 0, 15, 14, 30)
    const result = formatDateTime(date)
    expect(result).toContain('2024')
    expect(result).toContain('14')
    expect(result).toContain('30')
  })

  it('应该处理无效日期', () => {
    expect(formatDateTime('invalid')).toBe('')
    expect(formatDateTime(new Date('invalid'))).toBe('')
  })
})

describe('truncate', () => {
  it('不应该截断短字符串', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('应该截断长字符串并添加省略号', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
    expect(truncate('hello world', 5)).toBe('he...')
  })

  it('应该处理空字符串', () => {
    expect(truncate('', 10)).toBe('')
  })

  it('应该正确处理边界情况', () => {
    expect(truncate('hello', 5)).toBe('hello')
    expect(truncate('hello', 4)).toBe('h...')
    expect(truncate('hello', 3)).toBe('...')
  })
})
