import { create } from 'zustand'

export interface OperationLog {
  timestamp: string
  action: string
  detail?: string
  error?: string
}

interface OperationLogStore {
  logs: OperationLog[]
  log: (action: string, detail?: string, error?: string) => void
  clear: () => void
  getAll: () => string[]
}

const formatTime = () => {
  const now = new Date()
  return now.toLocaleTimeString('zh-CN', { hour12: false })
}

export const useOperationLogStore = create<OperationLogStore>((set, get) => ({
  logs: [],

  log: (action, detail, error) => {
    const entry: OperationLog = {
      timestamp: formatTime(),
      action,
      detail,
      error,
    }
    set((state) => ({
      logs: [...state.logs.slice(-199), entry],
    }))
  },

  clear: () => {
    set({ logs: [] })
  },

  getAll: () => {
    return get().logs.map((log) => {
      let line = `[${log.timestamp}] ${log.action}`
      if (log.detail) line += ` - ${log.detail}`
      if (log.error) line += ` [错误: ${log.error}]`
      return line
    })
  },
}))
