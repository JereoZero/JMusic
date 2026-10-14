export { default as ProgressBar } from './ProgressBar'
export { default as VolumeControl } from './VolumeControl'
export { default as PlaybackControls } from './PlaybackControls'
// QueuePanel 不从此处导出：它是 framer-motion 的首屏消费者，
// 必须由 PlayerBar 用 lazy(() => import('./player/QueuePanel')) 按需加载
