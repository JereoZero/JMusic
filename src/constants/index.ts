import type { PlayMode, ViewType } from '../types'

export type { PlayMode, ViewType }

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

  all: [] as readonly string[],
} as const

const _allFormats = [...AUDIO_FORMATS.normal, ...AUDIO_FORMATS.encrypted, ...AUDIO_FORMATS.unsupported]
Object.defineProperty(AUDIO_FORMATS, 'all', { value: _allFormats })

export function isAudioFormat(ext: string): boolean {
  return AUDIO_FORMATS.all.includes(ext.toLowerCase())
}

export function isEncryptedFormat(ext: string): boolean {
  return (AUDIO_FORMATS.encrypted as ReadonlyArray<string>).includes(ext.toLowerCase())
}

export function isNormalFormat(ext: string): boolean {
  return (AUDIO_FORMATS.normal as ReadonlyArray<string>).includes(ext.toLowerCase())
}

export const PLAY_MODES: readonly PlayMode[] = ['list', 'loop', 'shuffle']

export const QUEUE_SOURCES = ['local', 'liked', 'history', 'hidden'] as const
export type QueueSource = (typeof QUEUE_SOURCES)[number]

export const VIEW_TYPES: readonly ViewType[] = ['local', 'liked', 'hidden', 'history', 'settings']
