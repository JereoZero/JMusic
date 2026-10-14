import { invokeApi } from './types'

export async function setSetting(key: string, value: string): Promise<void> {
  await invokeApi<void>('set_setting', { key, value })
}

export async function selectFolder(): Promise<string | null> {
  return await invokeApi<string | null>('select_folder')
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
