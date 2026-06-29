import { create } from 'zustand'

export type DialogVariant = 'default' | 'danger'

export interface DialogOptions {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: DialogVariant
}

interface DialogState {
  open: boolean
  options: DialogOptions | null
  resolver: ((value: boolean) => void) | null
  show: (options: DialogOptions) => Promise<boolean>
  resolve: (value: boolean) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  open: false,
  options: null,
  resolver: null,

  show: (options) => {
    // 关闭已存在的对话框，旧 Promise 直接 reject 为 false
    const prevResolver = get().resolver
    if (prevResolver) prevResolver(false)

    return new Promise<boolean>((resolve) => {
      set({ open: true, options, resolver: resolve })
    })
  },

  resolve: (value) => {
    const resolver = get().resolver
    if (resolver) resolver(value)
    set({ open: false, options: null, resolver: null })
  },
}))

/**
 * 编程式调用确认对话框，替换浏览器原生 confirm()。
 * 用法：`if (await confirmDialog({ title: '...' })) { ... }`
 */
export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return useDialogStore.getState().show(options)
}
