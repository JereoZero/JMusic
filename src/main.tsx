import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'
import { THEMES, DEFAULT_THEME_ID, type ThemeId } from './config/themes'

// 同步从 localStorage 读取主题，在 React 渲染前设置 CSS 变量，消除首帧主题闪烁（FOUC）
;(function applyInitialTheme() {
  try {
    const raw = localStorage.getItem('theme-storage')
    if (raw) {
      const parsed = JSON.parse(raw)
      const themeId = parsed?.state?.currentThemeId as ThemeId | undefined
      const primary = themeId && THEMES[themeId] ? THEMES[themeId].primary : THEMES[DEFAULT_THEME_ID].primary
      document.documentElement.style.setProperty('--primary-color', primary)
      document.documentElement.style.setProperty('--logo-color', primary)
    }
  } catch {
    // 解析失败时使用 :root 默认值，无需处理
  }
})()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found in DOM')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
