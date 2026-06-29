import { invokeApi } from './types'

export async function getSetting(key: string): Promise<string | null> {
  return (await invokeApi<string | null>('get_setting', { key })) ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invokeApi<void>('set_setting', { key, value })
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const data = (await invokeApi<Array<[string, string]>>('get_all_settings')) ?? []
  return Object.fromEntries(data)
}

export async function checkFileExists(path: string): Promise<boolean> {
  return (await invokeApi<boolean>('check_file_exists', { path })) ?? false
}

export async function selectFolder(): Promise<string | null> {
  return (await invokeApi<string | null>('select_folder')) ?? null
}

export async function getPrimaryMusicFolder(): Promise<string> {
  return await invokeApi<string>('get_primary_music_folder')
}

export async function addSecondaryFolder(targetPath: string): Promise<string> {
  return await invokeApi<string>('add_secondary_folder', { targetPath })
}

export async function removeSecondaryFolder(linkName: string): Promise<void> {
  await invokeApi<void>('remove_secondary_folder', { linkName })
}

export async function getSecondaryFolders(): Promise<Array<{ name: string; target: string }>> {
  const data = (await invokeApi<Array<[string, string]>>('get_secondary_folders')) ?? []
  return data.map(([name, target]) => ({ name, target }))
}

export async function cleanupNonexistentSongs(baseFolder: string): Promise<number> {
  // 清理可能涉及大量文件存在性检查，使用 2 分钟超时
  return (await invokeApi<number>('cleanup_nonexistent_songs', { baseFolder }, 120_000)) ?? 0
}
