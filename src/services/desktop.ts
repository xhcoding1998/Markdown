import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type { FileNode, SearchResult, TrashItem } from '../types'

export const isTauri = () => '__TAURI_INTERNALS__' in window

export async function chooseWorkspace(): Promise<string | null> {
  if (!isTauri()) return '码档示例目录'
  const selected = await open({ directory: true, multiple: false, title: '打开本地目录' })
  return typeof selected === 'string' ? selected : null
}

export async function chooseMarkdownFiles(): Promise<string[] | null> {
  if (!isTauri()) return null
  const selected = await open({
    directory: false,
    multiple: true,
    title: '打开本地文件',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  })
  if (!selected) return null
  return Array.isArray(selected) ? selected : [selected]
}

export async function openMarkdownFiles(paths: string[]): Promise<FileNode[]> {
  return invoke<FileNode[]>('open_files', { paths })
}

export async function openWorkspace(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>('open_workspace', { path })
}

export async function readDocument(relativePath: string): Promise<string> {
  return invoke<string>('read_text_file', { relativePath })
}

export async function writeDocument(relativePath: string, content: string): Promise<void> {
  await invoke('write_text_file', { relativePath, content })
}

export async function createDocument(relativePath: string): Promise<FileNode> {
  return invoke<FileNode>('create_file', { relativePath })
}

export async function createFolder(relativePath: string): Promise<FileNode> {
  return invoke<FileNode>('create_directory', { relativePath })
}

export async function renameEntry(relativePath: string, newName: string): Promise<void> {
  await invoke('rename_entry', { relativePath, newName })
}

export async function moveEntry(relativePath: string, targetDirectory: string): Promise<void> {
  await invoke('move_entry', { relativePath, targetDirectory })
}

export async function importFiles(sourcePaths: string[], targetDirectory = ''): Promise<number> {
  return invoke<number>('import_files', { sourcePaths, targetDirectory })
}

export async function trashEntry(relativePath: string): Promise<void> {
  await invoke('trash_entry', { relativePath })
}

export async function listTrash(): Promise<TrashItem[]> {
  return invoke<TrashItem[]>('list_trash')
}

export async function restoreTrash(id: string): Promise<TrashItem> {
  return invoke<TrashItem>('restore_trash', { id })
}

export async function permanentlyDeleteTrash(id: string): Promise<void> {
  await invoke('delete_trash', { id })
}

export async function quitApplication(): Promise<void> {
  await invoke('exit_application')
}

export async function revealInFileManager(path: string): Promise<void> {
  if (!isTauri()) return
  await revealItemInDir(path)
}

export async function searchWorkspace(query: string): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_workspace', { query, limit: 200 })
}

export async function exportHtml(suggestedName: string, html: string): Promise<boolean> {
  if (!isTauri()) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = suggestedName
    anchor.click()
    URL.revokeObjectURL(url)
    return true
  }

  const target = await save({ defaultPath: suggestedName, filters: [{ name: 'HTML', extensions: ['html'] }] })
  if (!target) return false
  await invoke('export_html', { targetPath: target, html })
  return true
}

type ExportFilter = { name: string; extensions: string[] }

function downloadBlob(suggestedName: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = suggestedName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportText(
  suggestedName: string,
  text: string,
  filter: ExportFilter,
  mimeType = 'text/plain;charset=utf-8',
): Promise<boolean> {
  if (!isTauri()) {
    downloadBlob(suggestedName, new Blob([text], { type: mimeType }))
    return true
  }

  const target = await save({ defaultPath: suggestedName, filters: [filter] })
  if (!target) return false
  await invoke('export_text', { targetPath: target, text })
  return true
}

export async function exportBinary(
  suggestedName: string,
  bytes: Uint8Array,
  filter: ExportFilter,
  mimeType: string,
): Promise<boolean> {
  if (!isTauri()) {
    downloadBlob(suggestedName, new Blob([bytes as BlobPart], { type: mimeType }))
    return true
  }

  const target = await save({ defaultPath: suggestedName, filters: [filter] })
  if (!target) return false
  await invoke('export_binary', { targetPath: target, dataBase64: bytesToBase64(bytes) })
  return true
}

export function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
