import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { THEMES, ThemeId, DEFAULT_THEME_ID } from '../config/themes'

interface ThemeState {
  currentThemeId: ThemeId
  setTheme: (id: ThemeId) => void
  getPrimaryColor: () => string
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      currentThemeId: DEFAULT_THEME_ID,
      setTheme: (id: ThemeId) => set({ currentThemeId: id }),
      getPrimaryColor: () => THEMES[get().currentThemeId].primary,
    }),
    {
      name: 'theme-storage',
    }
  )
)

export function getPrimaryColor(): string {
  return THEMES[useThemeStore.getState().currentThemeId].primary
}
