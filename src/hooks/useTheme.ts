import { useEffect } from 'react'
import { useThemeStore } from '../stores/themeStore'
import { THEMES } from '../config/themes'

export function useTheme() {
  const currentThemeId = useThemeStore((s) => s.currentThemeId)
  const setTheme = useThemeStore((s) => s.setTheme)
  const primaryColor = useThemeStore((s) => THEMES[s.currentThemeId].primary)

  useEffect(() => {
    // 更新 CSS 变量
    const root = document.documentElement
    root.style.setProperty('--primary-color', primaryColor)
  }, [primaryColor])

  return {
    currentThemeId,
    setTheme,
    primaryColor,
  }
}
