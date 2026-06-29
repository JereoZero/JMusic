import { create } from 'zustand'
import { LRUCache } from 'lru-cache'
import { getColor } from 'colorthief'
import { mutex } from 'async-mutex-lite'
import { colord } from 'colord'
import api from '../api'
import { usePlayerStore } from './playerStore'
import { coverCache, getPendingCoverRequest } from '../hooks/useSongCover'

export interface AlbumColors {
  lyrics: string | null
  playerBar: string | null
  main: string | null
  sidebar: string | null
}

export const NULL_COLORS: AlbumColors = {
  lyrics: null,
  playerBar: null,
  main: null,
  sidebar: null,
}

// 颜色缓存：max 30 → 200，减少频繁切歌时的重新提取
const colorCache = new LRUCache<string, AlbumColors>({ max: 200 })

async function extractColors(coverBase64: string): Promise<AlbumColors> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = async () => {
      try {
        const color = await getColor(img)
        if (!color) {
          resolve(NULL_COLORS)
          return
        }
        const { r, g, b } = color.rgb()
        const { h, s } = colord({ r, g, b }).toHsl()
        resolve({
          lyrics: colord({ h, s, l: 12 }).toHex(),
          playerBar: colord({ h, s, l: 7 }).toHex(),
          main: colord({ h, s, l: 10 }).toHex(),
          sidebar: colord({ h, s, l: 9 }).toHex(),
        })
      } catch {
        resolve(NULL_COLORS)
      }
    }
    img.onerror = () => resolve(NULL_COLORS)
    img.crossOrigin = 'anonymous'
    img.src = `data:image/jpeg;base64,${coverBase64}`
  })
}

async function getColors(songPath: string, coverBase64: string): Promise<AlbumColors> {
  const result = await mutex(songPath, async () => {
    const cached = colorCache.get(songPath)
    if (cached) return cached
    try {
      const colors = await extractColors(coverBase64)
      colorCache.set(songPath, colors)
      return colors
    } catch {
      return NULL_COLORS
    }
  })
  return result ?? NULL_COLORS
}

interface CoverState {
  path: string | null
  cover: string | null
  colors: AlbumColors
  isLoading: boolean
}

export const useCoverStore = create<CoverState>(() => ({
  path: null,
  cover: null,
  colors: NULL_COLORS,
  isLoading: false,
}))

let loadingPath: string | null = null

/**
 * 加载指定歌曲的封面和颜色，路径变化时取消旧请求。
 * 内部用 loadingPath 串行化，避免快速切歌时旧请求覆盖新状态。
 */
async function loadCoverAndColors(path: string | null) {
  // 路径未变则不处理
  if (useCoverStore.getState().path === path) return
  loadingPath = path

  if (!path) {
    useCoverStore.setState({ path: null, cover: null, colors: NULL_COLORS, isLoading: false })
    return
  }

  // 同步设置 path + 命中缓存的 cover/colors（避免切歌瞬间闪烁旧色）
  const cachedCover = coverCache.get(path) ?? null
  const cachedColors = colorCache.get(path) ?? NULL_COLORS
  useCoverStore.setState({
    path,
    cover: cachedCover,
    colors: cachedColors,
    isLoading: !cachedCover,
  })

  // 异步加载 cover（若未命中缓存）
  let cover = cachedCover
  if (!cover) {
    // #10 修复：先检查 useSongCover 是否已有 in-flight 请求，避免双倍请求
    const pending = getPendingCoverRequest(path)
    try {
      cover = pending ? await pending : await api.getSongCoverFull(path)
    } catch {
      cover = null
    }
    // #5 修复：先入缓存再判断是否丢弃，避免 A→B→A 时重复请求
    if (cover) coverCache.set(path, cover)
    // 路径已变化，放弃结果（不 setState，但封面已入缓存供下次命中）
    if (loadingPath !== path) return
    useCoverStore.setState({ cover, isLoading: false })
  }

  // 提取颜色（若未命中缓存）
  if (cover && cachedColors === NULL_COLORS) {
    const colors = await getColors(path, cover)
    if (loadingPath !== path) return
    useCoverStore.setState({ colors })
  }
}

let unsubscribePlayer: (() => void) | null = null

/**
 * 初始化 coverStore：订阅 playerStore.currentSong 变化。
 * 应在 App 初始化时调用一次。
 */
export function initCoverStore() {
  if (unsubscribePlayer) return
  // 订阅 currentSong 变化（zustand subscribe 默认订阅整个 state，需自行比较）
  let lastPath: string | null = null
  unsubscribePlayer = usePlayerStore.subscribe((state) => {
    const newPath = state.currentSong?.path ?? null
    if (newPath !== lastPath) {
      lastPath = newPath
      void loadCoverAndColors(newPath)
    }
  })
}

export function clearCoverStoreCache() {
  coverCache.clear()
  colorCache.clear()
  // #2 修复：重置 path，否则 loadCoverAndColors 开头的 path===path 检查会跳过重载
  useCoverStore.setState({ path: null, cover: null, colors: NULL_COLORS, isLoading: false })
}

/**
 * #3 修复：rescan 后重新加载当前歌曲的封面和颜色。
 * clearCoverStoreCache 重置了 path，但 currentSong 未变不会触发订阅，需手动重载。
 */
export function reloadCurrentCover() {
  const currentPath = usePlayerStore.getState().currentSong?.path ?? null
  void loadCoverAndColors(currentPath)
}

// #1 修复：HMR 时取消旧订阅，避免泄漏（与 playerStore/useSongCover 的 HMR 清理一致）
if ((import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (unsubscribePlayer) {
      unsubscribePlayer()
      unsubscribePlayer = null
    }
  })
}
