// 音频格式常量：**本文件仅保留 AUDIO_FORMATS**（SongItem 用于标记「不支持」的行样式）。
//
// 曾还导出 isAudioFormat / isEncryptedFormat / isNormalFormat / PLAY_MODES /
// QUEUE_SOURCES / VIEW_TYPES 及 QueueSource 类型 —— 全部零调用：
//   - 格式判断函数未被任何组件使用（后端 constants.rs 才是格式校验的真源）
//   - QUEUE_SOURCES / QueueSource：真实类型在 stores/playQueueStore.ts 内联定义
//   - VIEW_TYPES / PLAY_MODES：App 用 ViewType、播放模式在 store 里
export const AUDIO_FORMATS = {
  normal: [
    'mp3',
    'flac',
    'wav',
    'ogg',
    'm4a',
    'aac',
    'alac',
    'dsf',
    'dff',
    'aif',
    'aiff',
    'opus',
    'caf',
  ] as const,

  encrypted: ['ncm', 'qmc', 'qmc0', 'qmc3', 'qmcflac', 'qmcogg', 'mflac'] as const,

  unsupported: ['wma', 'ape', 'wv', 'wvc', 'tta'] as const,
} as const
