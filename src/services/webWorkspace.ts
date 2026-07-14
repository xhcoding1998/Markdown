import type { FileNode, SearchResult } from '../types'

type VirtualEntry = { path: string; kind: 'file' | 'directory'; content?: string; createdAt?: number; modifiedAt?: number }
type VirtualWorkspace = { name: string; entries: VirtualEntry[] }
type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(options?: { mode: 'readwrite' }): Promise<PermissionState>
}
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

const DB_NAME = 'markdown-studio-web'
const DB_STORE = 'workspace'
const VIRTUAL_KEY = 'virtual-workspace'
const HANDLE_KEY = 'directory-handle'
const DETACHED_KEY = 'workspace-detached'

let mode: 'virtual' | 'directory' = 'virtual'
let directoryHandle: FileSystemDirectoryHandle | undefined
let virtualWorkspace: VirtualWorkspace = { name: '', entries: [] }

const legacyDemoFiles = new Set([
  '产品文档/产品需求文档.md',
  '产品文档/功能清单.md',
  '产品文档/用户故事.md',
  '技术文档/接口文档.md',
  '技术文档/数据库设计.md',
  '会议记录/产品周会 2026-07-13.md',
])

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function databaseGet<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readonly')
    const request = transaction.objectStore(DB_STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

async function databasePut(key: string, value: unknown): Promise<void> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readwrite')
    transaction.objectStore(DB_STORE).put(value, key)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => reject(transaction.error)
  })
}

async function databaseDelete(key: string): Promise<void> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readwrite')
    transaction.objectStore(DB_STORE).delete(key)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => reject(transaction.error)
  })
}

async function persistVirtualWorkspace() {
  await databasePut(VIRTUAL_KEY, virtualWorkspace)
}

export function isDirectoryWorkspace() {
  return mode === 'directory'
}

export async function initialize() {
  const detached = await databaseGet<boolean>(DETACHED_KEY).catch(() => false)
  if (detached) {
    mode = 'virtual'
    directoryHandle = undefined
    return { name: '', tree: [] as FileNode[] }
  }
  const savedHandle = await databaseGet<FileSystemDirectoryHandle>(HANDLE_KEY).catch(() => undefined)
  if (savedHandle) {
    const permission = await (savedHandle as PermissionDirectoryHandle).queryPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)
    if (permission === 'granted') {
      mode = 'directory'
      directoryHandle = savedHandle
      return { name: savedHandle.name, tree: await scanDirectory(savedHandle) }
    }
  }

  const saved = await databaseGet<VirtualWorkspace>(VIRTUAL_KEY).catch(() => undefined)
  if (!saved || isLegacyDemoWorkspace(saved)) {
    virtualWorkspace = { name: '', entries: [] }
    if (saved) await databaseDelete(VIRTUAL_KEY).catch(() => undefined)
    return { name: '', tree: [] as FileNode[] }
  }
  virtualWorkspace = saved
  mode = 'virtual'
  directoryHandle = undefined
  return { name: virtualWorkspace.name, tree: buildVirtualTree() }
}

function isLegacyDemoWorkspace(workspace: VirtualWorkspace) {
  if (workspace.name !== '码档目录') return false
  const files = workspace.entries.filter((entry) => entry.kind === 'file')
  return files.length === legacyDemoFiles.size && files.every((entry) => legacyDemoFiles.has(entry.path))
}

export async function chooseDirectory() {
  type DirectoryPickerOptions = { mode?: 'readwrite'; id?: string; startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' }
  const picker = (window as Window & { showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
  if (!picker) {
    const files = await chooseDirectoryFiles()
    return files ? openDirectoryFiles(files) : null
  }
  try {
    const handle = await picker.call(window, { mode: 'readwrite', id: 'markdown-studio-workspace', startIn: 'documents' })
    const permissionHandle = handle as PermissionDirectoryHandle
    const permission = await permissionHandle.requestPermission?.({ mode: 'readwrite' })
    if (permission && permission !== 'granted') throw new Error('需要读写权限才能打开此目录。')
    mode = 'directory'
    directoryHandle = handle
    await databasePut(DETACHED_KEY, false)
    await databasePut(HANDLE_KEY, handle)
    return { name: handle.name, tree: await scanDirectory(handle) }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    if (error instanceof DOMException && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) {
      throw new Error('浏览器不能直接授权整个磁盘根目录，请选择 C 盘或其他磁盘中的一个具体文件夹。')
    }
    throw error
  }
}

function chooseDirectoryFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.md,.markdown,text/markdown,text/plain'
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[] | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(input.files?.length ? [...input.files] : null), { once: true })
    window.addEventListener('focus', () => window.setTimeout(() => finish(input.files?.length ? [...input.files] : null), 250), { once: true })
    input.click()
  })
}

async function openDirectoryFiles(files: File[]) {
  const markdownFiles = files.filter((file) => /\.md(?:own)?$/i.test(file.name))
  if (!markdownFiles.length) throw new Error('所选文件夹中没有 Markdown 文档。')

  const firstRelativePath = markdownFiles[0].webkitRelativePath || markdownFiles[0].name
  const rootName = firstRelativePath.includes('/') ? firstRelativePath.split('/')[0] : '本地目录'
  const now = Date.now()
  const entries: VirtualEntry[] = []

  for (const file of markdownFiles) {
    const browserPath = file.webkitRelativePath || file.name
    const parts = browserPath.split('/').filter(Boolean)
    const relativeParts = parts.length > 1 ? parts.slice(1) : parts
    const relativePath = relativeParts.join('/')
    relativeParts.slice(0, -1).forEach((_, index) => {
      const path = relativeParts.slice(0, index + 1).join('/')
      if (!entries.some((entry) => entry.path === path)) entries.push({ path, kind: 'directory', createdAt: now, modifiedAt: now })
    })
    entries.push({
      path: relativePath,
      kind: 'file',
      content: await file.text(),
      createdAt: file.lastModified || now,
      modifiedAt: file.lastModified || now,
    })
  }

  mode = 'virtual'
  directoryHandle = undefined
  virtualWorkspace = { name: rootName, entries }
  await databasePut(DETACHED_KEY, false)
  await databaseDelete(HANDLE_KEY).catch(() => undefined)
  await persistVirtualWorkspace()
  return { name: virtualWorkspace.name, tree: buildVirtualTree() }
}

export function chooseMarkdownFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.md,.markdown,text/markdown,text/plain'
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[] | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(input.files?.length ? [...input.files] : null), { once: true })
    window.addEventListener('focus', () => window.setTimeout(() => finish(input.files?.length ? [...input.files] : null), 250), { once: true })
    input.click()
  })
}

export async function openMarkdownFiles(files: File[]) {
  const now = Date.now()
  mode = 'virtual'
  directoryHandle = undefined
  virtualWorkspace = {
    name: '默认文件',
    entries: files.map((file) => ({
      path: file.name,
      kind: 'file' as const,
      content: '',
      createdAt: file.lastModified || now,
      modifiedAt: file.lastModified || now,
    })),
  }
  for (const entry of virtualWorkspace.entries) {
    const file = files.find((candidate) => candidate.name === entry.path)
    entry.content = file ? await file.text() : ''
  }
  await databasePut(DETACHED_KEY, false)
  await databaseDelete(HANDLE_KEY).catch(() => undefined)
  await persistVirtualWorkspace()
  return { name: virtualWorkspace.name, tree: buildVirtualTree() }
}

export async function detachWorkspace() {
  mode = 'virtual'
  directoryHandle = undefined
  await databasePut(DETACHED_KEY, true)
  await databaseDelete(HANDLE_KEY).catch(() => undefined)
}

export async function refresh(): Promise<FileNode[]> {
  return mode === 'directory' && directoryHandle ? scanDirectory(directoryHandle) : buildVirtualTree()
}

export async function readDocument(relativePath: string): Promise<string> {
  if (mode === 'directory' && directoryHandle) {
    const { parent, name } = await directoryParent(relativePath)
    return (await (await parent.getFileHandle(name)).getFile()).text()
  }
  const entry = virtualWorkspace.entries.find((item) => item.path === relativePath && item.kind === 'file')
  if (!entry) throw new Error('文件不存在。')
  return entry.content || ''
}

export async function writeDocument(relativePath: string, content: string) {
  if (mode === 'directory' && directoryHandle) {
    const { parent, name } = await directoryParent(relativePath)
    const writable = await (await parent.getFileHandle(name, { create: true })).createWritable()
    await writable.write(content)
    await writable.close()
    return
  }
  const entry = virtualWorkspace.entries.find((item) => item.path === relativePath && item.kind === 'file')
  if (!entry) throw new Error('文件不存在。')
  entry.content = content
  entry.modifiedAt = Date.now()
  await persistVirtualWorkspace()
}

export async function createDocument(relativePath: string) {
  await ensureAvailable(relativePath)
  if (mode === 'directory' && directoryHandle) {
    const { parent, name } = await directoryParent(relativePath)
    await parent.getFileHandle(name, { create: true })
  } else {
    const now = Date.now()
    virtualWorkspace.entries.push({ path: relativePath, kind: 'file', content: '', createdAt: now, modifiedAt: now })
    await persistVirtualWorkspace()
  }
  return fileNode(relativePath, 'file')
}

export async function createFolder(relativePath: string) {
  await ensureAvailable(relativePath)
  if (mode === 'directory' && directoryHandle) {
    const { parent, name } = await directoryParent(relativePath)
    await parent.getDirectoryHandle(name, { create: true })
  } else {
    const now = Date.now()
    virtualWorkspace.entries.push({ path: relativePath, kind: 'directory', createdAt: now, modifiedAt: now })
    await persistVirtualWorkspace()
  }
  return fileNode(relativePath, 'directory')
}

export async function deleteEntry(relativePath: string) {
  if (mode === 'directory' && directoryHandle) {
    const { parent, name } = await directoryParent(relativePath)
    await parent.removeEntry(name, { recursive: true })
  } else {
    virtualWorkspace.entries = virtualWorkspace.entries.filter((entry) => entry.path !== relativePath && !entry.path.startsWith(`${relativePath}/`))
    await persistVirtualWorkspace()
  }
}

export async function renameEntry(relativePath: string, newName: string) {
  const parentPath = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  const nextPath = parentPath ? `${parentPath}/${newName}` : newName
  await relocateEntry(relativePath, nextPath)
}

export async function moveEntry(relativePath: string, targetDirectory: string) {
  const name = relativePath.split('/').pop() || relativePath
  const nextPath = targetDirectory ? `${targetDirectory}/${name}` : name
  await relocateEntry(relativePath, nextPath)
}

async function relocateEntry(relativePath: string, nextPath: string) {
  if (relativePath === nextPath) return
  await ensureAvailable(nextPath)
  if (mode === 'directory' && directoryHandle) {
    const source = await getHandle(relativePath)
    const targetParentPath = nextPath.includes('/') ? nextPath.slice(0, nextPath.lastIndexOf('/')) : ''
    const targetName = nextPath.split('/').pop() || nextPath
    const targetParent = await getDirectory(targetParentPath)
    await copyHandle(source, targetParent, targetName)
    const { parent, name } = await directoryParent(relativePath)
    await parent.removeEntry(name, { recursive: true })
  } else {
    virtualWorkspace.entries = virtualWorkspace.entries.map((entry) => {
      if (entry.path === relativePath || entry.path.startsWith(`${relativePath}/`)) {
        return { ...entry, path: `${nextPath}${entry.path.slice(relativePath.length)}` }
      }
      return entry
    })
    await persistVirtualWorkspace()
  }
}

export async function importFiles(files: File[], targetDirectory = '') {
  for (const file of files.filter((item) => /\.md(?:own)?$/i.test(item.name))) {
    const relativePath = targetDirectory ? `${targetDirectory}/${file.name}` : file.name
    await ensureAvailable(relativePath)
    if (mode === 'directory' && directoryHandle) {
      const { parent, name } = await directoryParent(relativePath)
      const writable = await (await parent.getFileHandle(name, { create: true })).createWritable()
      await writable.write(file)
      await writable.close()
    } else {
      virtualWorkspace.entries.push({ path: relativePath, kind: 'file', content: await file.text(), createdAt: file.lastModified, modifiedAt: file.lastModified })
    }
  }
  if (mode === 'virtual') await persistVirtualWorkspace()
}

export async function search(query: string, limit = 200): Promise<SearchResult[]> {
  const needle = query.toLowerCase()
  const files = flattenFiles(await refresh())
  const results: SearchResult[] = []
  for (const file of files) {
    if (results.length >= limit) break
    const content = await readDocument(file.relativePath)
    if (file.name.toLowerCase().includes(needle)) results.push({ path: file.path, relativePath: file.relativePath, line: 1, column: 1, preview: '文件名匹配' })
    for (const [index, line] of content.split('\n').entries()) {
      if (results.length >= limit) break
      const column = line.toLowerCase().indexOf(needle)
      if (column >= 0) results.push({ path: file.path, relativePath: file.relativePath, line: index + 1, column: column + 1, preview: line.trim().slice(0, 100) })
    }
  }
  return results
}

function buildVirtualTree(): FileNode[] {
  const roots: FileNode[] = []
  const nodes = new Map<string, FileNode>()
  for (const entry of [...virtualWorkspace.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const node = fileNode(entry.path, entry.kind, entry.createdAt, entry.modifiedAt)
    nodes.set(entry.path, node)
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    if (!parentPath) roots.push(node)
    else nodes.get(parentPath)?.children?.push(node)
  }
  return sortTree(roots)
}

async function scanDirectory(directory: FileSystemDirectoryHandle, prefix = ''): Promise<FileNode[]> {
  const nodes: FileNode[] = []
  for await (const [name, handle] of (directory as IterableDirectoryHandle).entries()) {
    if (name.startsWith('.') || (!/\.md(?:own)?$/i.test(name) && handle.kind === 'file')) continue
    const relativePath = prefix ? `${prefix}/${name}` : name
    const file = handle.kind === 'file' ? await (handle as FileSystemFileHandle).getFile() : undefined
    nodes.push({
      name,
      path: relativePath,
      relativePath,
      kind: handle.kind,
      children: handle.kind === 'directory' ? await scanDirectory(handle as FileSystemDirectoryHandle, relativePath) : undefined,
      modifiedAt: file?.lastModified,
    })
  }
  return sortTree(nodes)
}

function sortTree(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN'))
}

function fileNode(relativePath: string, kind: 'file' | 'directory', createdAt?: number, modifiedAt?: number): FileNode {
  return { name: relativePath.split('/').pop() || relativePath, path: relativePath, relativePath, kind, children: kind === 'directory' ? [] : undefined, createdAt, modifiedAt }
}

async function getDirectory(relativePath: string): Promise<FileSystemDirectoryHandle> {
  if (!directoryHandle) throw new Error('尚未打开本地文件夹。')
  let current = directoryHandle
  for (const segment of relativePath.split('/').filter(Boolean)) current = await current.getDirectoryHandle(segment)
  return current
}

async function directoryParent(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error('路径无效。')
  return { parent: await getDirectory(parts.join('/')), name }
}

async function getHandle(relativePath: string): Promise<FileSystemHandle> {
  const { parent, name } = await directoryParent(relativePath)
  try { return await parent.getFileHandle(name) } catch { return parent.getDirectoryHandle(name) }
}

async function ensureAvailable(relativePath: string) {
  if (mode === 'virtual') {
    if (virtualWorkspace.entries.some((entry) => entry.path === relativePath)) throw new Error('目标位置已经存在同名项目。')
    return
  }
  try {
    await getHandle(relativePath)
    throw new Error('目标位置已经存在同名项目。')
  } catch (error) {
    if (error instanceof Error && error.message === '目标位置已经存在同名项目。') throw error
  }
}

async function copyHandle(source: FileSystemHandle, targetParent: FileSystemDirectoryHandle, targetName: string) {
  if (source.kind === 'file') {
    const file = await (source as FileSystemFileHandle).getFile()
    const writable = await (await targetParent.getFileHandle(targetName, { create: true })).createWritable()
    await writable.write(file)
    await writable.close()
    return
  }
  const target = await targetParent.getDirectoryHandle(targetName, { create: true })
  for await (const [name, child] of (source as IterableDirectoryHandle).entries()) await copyHandle(child, target, name)
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => node.kind === 'file' ? [node] : flattenFiles(node.children || []))
}
