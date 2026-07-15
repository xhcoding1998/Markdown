import type { FileNode, SearchResult } from '../types'

type VirtualEntry = { path: string; kind: 'file' | 'directory'; content?: string; createdAt?: number; modifiedAt?: number }
type VirtualAsset = { path: string; blob: Blob; type: string; size: number; createdAt: number }
type VirtualWorkspace = { name: string; scope?: 'files' | 'directory'; entries: VirtualEntry[]; assets?: VirtualAsset[] }
export type WebStorageAsset = { path: string; name: string; type: string; size: number; createdAt: number; references: string[] }
export type WebStorageDocument = { path: string; size: number; assetSize: number; assetCount: number; totalSize: number }
export type WebStorageSnapshot = {
  mode: 'virtual' | 'directory'
  totalSize: number
  documentBytes: number
  assetBytes: number
  documents: WebStorageDocument[]
  assets: WebStorageAsset[]
  unreferencedAssets: WebStorageAsset[]
  originUsage?: number
  quota?: number
}
export type WebBackupSummary = { name: string; documentCount: number; assetCount: number; totalSize: number }
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
const MANAGED_ASSETS_KEY = 'managed-directory-assets'

let mode: 'virtual' | 'directory' = 'virtual'
let directoryHandle: FileSystemDirectoryHandle | undefined
let virtualWorkspace: VirtualWorkspace = { name: '', scope: 'directory', entries: [] }
let managedDirectoryAssets = new Map<string, number>()

type ManagedDirectoryAssetRecord = { workspace: string; handle?: FileSystemDirectoryHandle; paths: Array<{ path: string; createdAt: number }> }

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
    return { name: '', mode: 'directory' as const, tree: [] as FileNode[] }
  }
  const savedHandle = await databaseGet<FileSystemDirectoryHandle>(HANDLE_KEY).catch(() => undefined)
  if (savedHandle) {
    const permission = await (savedHandle as PermissionDirectoryHandle).queryPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)
    if (permission === 'granted') {
      mode = 'directory'
      directoryHandle = savedHandle
      await loadManagedDirectoryAssets()
      return { name: savedHandle.name, mode: 'directory' as const, tree: await scanDirectory(savedHandle) }
    }
  }

  const saved = await databaseGet<VirtualWorkspace>(VIRTUAL_KEY).catch(() => undefined)
  if (!saved || isLegacyDemoWorkspace(saved)) {
    virtualWorkspace = { name: '', scope: 'directory', entries: [] }
    if (saved) await databaseDelete(VIRTUAL_KEY).catch(() => undefined)
    return { name: '', mode: 'directory' as const, tree: [] as FileNode[] }
  }
  virtualWorkspace = saved
  virtualWorkspace.scope ||= virtualWorkspace.name === '默认文件' ? 'files' : 'directory'
  virtualWorkspace.assets ||= []
  mode = 'virtual'
  directoryHandle = undefined
  return { name: virtualWorkspace.name, mode: virtualWorkspace.scope, tree: buildVirtualTree() }
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
    await loadManagedDirectoryAssets()
    await databasePut(DETACHED_KEY, false)
    await databasePut(HANDLE_KEY, handle)
    return { name: handle.name, mode: 'directory' as const, tree: await scanDirectory(handle) }
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
  virtualWorkspace = { name: rootName, scope: 'directory', entries }
  await databasePut(DETACHED_KEY, false)
  await databaseDelete(HANDLE_KEY).catch(() => undefined)
  await persistVirtualWorkspace()
  return { name: virtualWorkspace.name, mode: 'directory' as const, tree: buildVirtualTree() }
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
    let focusFallback: number | undefined
    const finish = (files: File[] | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(focusFallback)
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(input.files?.length ? [...input.files] : null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    window.addEventListener('focus', () => {
      // Safari on macOS can restore window focus before dispatching the input's
      // change event. Give that event enough time to arrive before treating the
      // picker as cancelled on browsers without a reliable `cancel` event.
      focusFallback = window.setTimeout(() => finish(input.files?.length ? [...input.files] : null), 1500)
    }, { once: true })
    input.click()
  })
}

export async function openMarkdownFiles(files: File[]) {
  const now = Date.now()
  mode = 'virtual'
  directoryHandle = undefined
  virtualWorkspace = {
    name: '默认文件',
    scope: 'files',
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
  return { name: virtualWorkspace.name, mode: 'files' as const, tree: buildVirtualTree() }
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

export async function saveImages(files: File[], documentPath: string) {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!images.length) return []
  const results: Array<{ path: string; reference: string; alt: string; size: number }> = []
  for (const [index, file] of images.entries()) {
    const path = `${documentAssetDirectory(documentPath)}/${createAssetName(file, index)}`
    if (mode === 'directory' && directoryHandle) {
      const { parent, name } = await directoryParent(path, true)
      const writable = await (await parent.getFileHandle(name, { create: true })).createWritable()
      await writable.write(file)
      await writable.close()
      managedDirectoryAssets.set(path, Date.now())
      await persistManagedDirectoryAssets()
    } else {
      virtualWorkspace.assets ||= []
      virtualWorkspace.assets.push({ path, blob: file, type: file.type || 'application/octet-stream', size: file.size, createdAt: Date.now() })
    }
    results.push({ path, reference: relativeReference(documentPath, path), alt: file.name.replace(/\.[^.]+$/, '') || '图片', size: file.size })
  }
  if (mode === 'virtual') await persistVirtualWorkspace()
  return results
}

export async function resolveAssetUrl(reference: string, documentPath: string): Promise<string | null> {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) return null
  const path = resolveDocumentReference(documentPath, reference)
  if (!path) return null
  try {
    if (mode === 'directory' && directoryHandle) {
      const { parent, name } = await directoryParent(path)
      const file = await (await parent.getFileHandle(name)).getFile()
      if (!file.type.startsWith('image/')) return null
      return URL.createObjectURL(file)
    }
    const asset = virtualWorkspace.assets?.find((item) => item.path === path)
    return asset ? URL.createObjectURL(asset.blob) : null
  } catch {
    return null
  }
}

export async function storageSnapshot(): Promise<WebStorageSnapshot> {
  const estimate: StorageEstimate = await navigator.storage?.estimate?.().catch(() => ({} as StorageEstimate)) || {}
  const assets = mode === 'directory'
    ? await directoryAssets()
    : (virtualWorkspace.assets || []).map((asset) => ({ ...asset, file: asset.blob }))
  const references = new Map<string, Set<string>>()
  const documentEntries = mode === 'directory'
    ? await Promise.all(flattenFiles(await refresh()).map(async (entry) => ({ path: entry.relativePath, content: await readDocument(entry.relativePath) })))
    : virtualWorkspace.entries.filter((entry) => entry.kind === 'file' && /\.md(?:own)?$/i.test(entry.path)).map((entry) => ({ path: entry.path, content: entry.content || '' }))
  const documents = documentEntries.map((entry) => {
    const content = entry.content
    const documentAssets = new Set<string>()
    for (const reference of markdownImageReferences(content)) {
      const path = resolveDocumentReference(entry.path, reference)
      if (!path || !assets.some((asset) => asset.path === path)) continue
      documentAssets.add(path)
      const owners = references.get(path) || new Set<string>()
      owners.add(entry.path)
      references.set(path, owners)
    }
    const size = new Blob([content]).size
    const assetSize = [...documentAssets].reduce((total, path) => total + (assets.find((asset) => asset.path === path)?.size || 0), 0)
    return { path: entry.path, size, assetSize, assetCount: documentAssets.size, totalSize: size + assetSize }
  })
  const assetItems = assets.map<WebStorageAsset>((asset) => ({
    path: asset.path,
    name: asset.path.split('/').pop() || asset.path,
    type: asset.type,
    size: asset.size,
    createdAt: asset.createdAt,
    references: [...(references.get(asset.path) || [])],
  }))
  const documentBytes = documents.reduce((total, document) => total + document.size, 0)
  const assetBytes = assetItems.reduce((total, asset) => total + asset.size, 0)
  return {
    mode,
    totalSize: documentBytes + assetBytes,
    documentBytes,
    assetBytes,
    documents: documents.sort((a, b) => b.totalSize - a.totalSize),
    assets: assetItems.sort((a, b) => b.size - a.size),
    unreferencedAssets: assetItems.filter((asset) => !asset.references.length),
    originUsage: estimate.usage,
    quota: estimate.quota,
  }
}

export async function deleteUnusedAssets(paths: string[]) {
  if (!paths.length) return 0
  const targets = new Set(paths)
  if (mode === 'directory' && directoryHandle) {
    let deleted = 0
    for (const path of targets) {
      if (!managedDirectoryAssets.has(path)) continue
      try {
        const { parent, name } = await directoryParent(path)
        await parent.removeEntry(name)
        deleted++
      } catch { /* Missing files are still removed from the ownership index. */ }
      managedDirectoryAssets.delete(path)
    }
    await persistManagedDirectoryAssets()
    return deleted
  }
  const before = virtualWorkspace.assets?.length || 0
  virtualWorkspace.assets = (virtualWorkspace.assets || []).filter((asset) => !targets.has(asset.path))
  await persistVirtualWorkspace()
  return before - virtualWorkspace.assets.length
}

export async function createWorkspaceBackup() {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const documents = flattenFiles(await refresh())
  for (const document of documents) zip.file(document.relativePath, await readDocument(document.relativePath))

  let assetCount = 0
  if (mode === 'directory' && directoryHandle) {
    const assets = await directoryAssets()
    assetCount = assets.length
    assets.forEach((asset) => zip.file(asset.path, asset.file))
  } else {
    const assets = virtualWorkspace.assets || []
    assetCount = assets.length
    assets.forEach((asset) => zip.file(asset.path, asset.blob))
  }
  zip.file('.madang/manifest.json', JSON.stringify({
    format: 'madang-backup',
    version: 1,
    name: virtualWorkspace.name || directoryHandle?.name || '码档文档',
    scope: virtualWorkspace.scope || 'directory',
    createdAt: new Date().toISOString(),
  }, null, 2))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' })
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  const baseName = safeBackupName(virtualWorkspace.name || directoryHandle?.name || '码档文档')
  return { blob, name: `${baseName}-码档备份-${stamp}.zip`, documentCount: documents.length, assetCount }
}

export function chooseBackupFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    let focusFallback: number | undefined
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(focusFallback)
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    window.addEventListener('focus', () => {
      focusFallback = window.setTimeout(() => finish(input.files?.[0] || null), 1500)
    }, { once: true })
    input.click()
  })
}

export async function inspectWorkspaceBackup(file: File): Promise<WebBackupSummary> {
  const parsed = await parseBackup(file, false)
  return { name: parsed.name, documentCount: parsed.documents.length, assetCount: parsed.assets.length, totalSize: parsed.totalSize }
}

export async function restoreWorkspaceBackup(file: File) {
  const parsed = await parseBackup(file, true)
  const now = Date.now()
  const entries: VirtualEntry[] = []
  const directories = new Set<string>()
  for (const document of parsed.documents) {
    const parts = document.path.split('/')
    parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join('/')))
  }
  [...directories].sort((a, b) => a.split('/').length - b.split('/').length).forEach((path) => entries.push({ path, kind: 'directory', createdAt: now, modifiedAt: now }))
  parsed.documents.forEach((document) => entries.push({ path: document.path, kind: 'file', content: document.content || '', createdAt: now, modifiedAt: now }))
  virtualWorkspace = {
    name: parsed.name,
    scope: 'directory',
    entries,
    assets: parsed.assets.map((asset) => ({ path: asset.path, blob: asset.blob!, type: asset.type, size: asset.size, createdAt: now })),
  }
  mode = 'virtual'
  directoryHandle = undefined
  await databasePut(DETACHED_KEY, false)
  await databaseDelete(HANDLE_KEY).catch(() => undefined)
  await persistVirtualWorkspace()
  return { name: virtualWorkspace.name, mode: 'directory' as const, tree: buildVirtualTree() }
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
  const isDocument = /\.md(?:own)?$/i.test(relativePath)
  const sourceAssetDirectory = isDocument ? documentAssetDirectory(relativePath) : ''
  const targetAssetDirectory = isDocument ? documentAssetDirectory(nextPath) : ''
  if (mode === 'directory' && directoryHandle) {
    const source = await getHandle(relativePath)
    const targetParentPath = nextPath.includes('/') ? nextPath.slice(0, nextPath.lastIndexOf('/')) : ''
    const targetName = nextPath.split('/').pop() || nextPath
    const targetParent = await getDirectory(targetParentPath)
    await copyHandle(source, targetParent, targetName)
    const { parent, name } = await directoryParent(relativePath)
    await parent.removeEntry(name, { recursive: true })
    if (sourceAssetDirectory && [...managedDirectoryAssets.keys()].some((path) => path.startsWith(`${sourceAssetDirectory}/`))) {
      try {
        const assetSource = await getHandle(sourceAssetDirectory)
        const assetTargetParentPath = targetAssetDirectory.includes('/') ? targetAssetDirectory.slice(0, targetAssetDirectory.lastIndexOf('/')) : ''
        const assetTargetName = targetAssetDirectory.split('/').pop() || targetAssetDirectory
        await copyHandle(assetSource, await getDirectory(assetTargetParentPath), assetTargetName)
        const assetParent = await directoryParent(sourceAssetDirectory)
        await assetParent.parent.removeEntry(assetParent.name, { recursive: true })
      } catch { /* The document may not have managed images. */ }
      const movedAssets = [...managedDirectoryAssets].filter(([path]) => path.startsWith(`${sourceAssetDirectory}/`))
      for (const [path, createdAt] of movedAssets) {
        managedDirectoryAssets.delete(path)
        managedDirectoryAssets.set(`${targetAssetDirectory}${path.slice(sourceAssetDirectory.length)}`, createdAt)
      }
      await persistManagedDirectoryAssets()
    }
  } else {
    virtualWorkspace.entries = virtualWorkspace.entries.map((entry) => {
      if (entry.path === relativePath || entry.path.startsWith(`${relativePath}/`)) {
        return { ...entry, path: `${nextPath}${entry.path.slice(relativePath.length)}` }
      }
      return entry
    })
    if (sourceAssetDirectory) {
      for (const asset of virtualWorkspace.assets || []) {
        if (asset.path.startsWith(`${sourceAssetDirectory}/`)) asset.path = `${targetAssetDirectory}${asset.path.slice(sourceAssetDirectory.length)}`
      }
    }
    await persistVirtualWorkspace()
  }

  if (isDocument && sourceAssetDirectory !== targetAssetDirectory) {
    const oldName = sourceAssetDirectory.split('/').pop() || sourceAssetDirectory
    const newName = targetAssetDirectory.split('/').pop() || targetAssetDirectory
    const updated = (await readDocument(nextPath)).split(`${oldName}/`).join(`${newName}/`)
    await writeDocument(nextPath, updated)
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
    if (name.startsWith('.') || (handle.kind === 'directory' && /\.assets$/i.test(name)) || (!/\.md(?:own)?$/i.test(name) && handle.kind === 'file')) continue
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

async function getDirectory(relativePath: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!directoryHandle) throw new Error('尚未打开本地文件夹。')
  let current = directoryHandle
  for (const segment of relativePath.split('/').filter(Boolean)) current = await current.getDirectoryHandle(segment, { create })
  return current
}

async function directoryParent(relativePath: string, create = false) {
  const parts = relativePath.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error('路径无效。')
  return { parent: await getDirectory(parts.join('/'), create), name }
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

function createAssetName(file: File, index: number) {
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 32) || 'image'
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6)
  return `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${index + 1}-${random}-${stem}.${extension}`
}

function relativeReference(documentPath: string, assetPath: string) {
  const from = documentPath.split('/').filter(Boolean)
  from.pop()
  const to = assetPath.split('/').filter(Boolean)
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  return `${'../'.repeat(from.length - common)}${to.slice(common).join('/')}`
}

function documentAssetDirectory(documentPath: string) {
  const parts = documentPath.replace(/\\/g, '/').split('/').filter(Boolean)
  const fileName = parts.pop() || 'document.md'
  const stem = fileName.replace(/\.(?:md|markdown)$/i, '') || 'document'
  return [...parts, `${stem}.assets`].join('/')
}

function resolveDocumentReference(documentPath: string, reference: string) {
  let decoded = reference.split(/[?#]/)[0]
  try { decoded = decodeURIComponent(decoded) } catch { /* Keep malformed paths unchanged so preview can fail gracefully. */ }
  decoded = decoded.replace(/\\/g, '/')
  const parts = documentPath.split('/').filter(Boolean)
  parts.pop()
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return ''
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

function markdownImageReferences(content: string) {
  const references: string[] = []
  for (const match of content.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) {
    const reference = match[1] || match[2]
    if (reference && !/^(?:data:|https?:|blob:|\/\/)/i.test(reference)) references.push(reference)
  }
  return references
}

async function directoryAssets() {
  if (!directoryHandle) return []
  const results: Array<{ path: string; file: File; type: string; size: number; createdAt: number }> = []
  let changed = false
  for (const [path, createdAt] of managedDirectoryAssets) {
    try {
      const { parent, name } = await directoryParent(path)
      const file = await (await parent.getFileHandle(name)).getFile()
      if (isImagePath(path)) results.push({ path, file, type: file.type || imageMime(path), size: file.size, createdAt })
    } catch {
      managedDirectoryAssets.delete(path)
      changed = true
    }
  }
  if (changed) await persistManagedDirectoryAssets()
  return results
}

async function loadManagedDirectoryAssets() {
  managedDirectoryAssets.clear()
  if (!directoryHandle) return
  const stored = await databaseGet<ManagedDirectoryAssetRecord[] | ManagedDirectoryAssetRecord>(MANAGED_ASSETS_KEY).catch(() => undefined)
  const records = Array.isArray(stored) ? stored : stored ? [stored] : []
  for (const record of records) {
    const sameDirectory = record.handle
      ? await record.handle.isSameEntry(directoryHandle).catch(() => false)
      : record.workspace === directoryHandle.name
    if (!sameDirectory) continue
    for (const item of record.paths || []) managedDirectoryAssets.set(item.path, item.createdAt)
    break
  }
}

async function persistManagedDirectoryAssets() {
  if (!directoryHandle) return
  const stored = await databaseGet<ManagedDirectoryAssetRecord[] | ManagedDirectoryAssetRecord>(MANAGED_ASSETS_KEY).catch(() => undefined)
  const records = Array.isArray(stored) ? stored : stored ? [stored] : []
  let existingIndex = -1
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const sameDirectory = record.handle
      ? await record.handle.isSameEntry(directoryHandle).catch(() => false)
      : record.workspace === directoryHandle.name
    if (sameDirectory) { existingIndex = index; break }
  }
  const next: ManagedDirectoryAssetRecord = {
    workspace: directoryHandle.name,
    handle: directoryHandle,
    paths: [...managedDirectoryAssets].map(([path, createdAt]) => ({ path, createdAt })),
  }
  if (existingIndex >= 0) records[existingIndex] = next
  else records.push(next)
  await databasePut(MANAGED_ASSETS_KEY, records)
}

async function parseBackup(file: File, keepBinary: boolean) {
  if (file.size > 512 * 1024 * 1024) throw new Error('备份包超过 512 MB，请拆分后再导入。')
  const { default: JSZip } = await import('jszip')
  let zip
  try {
    zip = await JSZip.loadAsync(file, { createFolders: true, checkCRC32: true })
  } catch {
    throw new Error('无法读取 ZIP，文件可能损坏、加密或不是有效的码档备份。')
  }

  const documents: Array<{ path: string; content?: string; size: number }> = []
  const assets: Array<{ path: string; blob?: Blob; type: string; size: number }> = []
  let backupName = file.name.replace(/(?:-码档备份-\d+)?\.zip$/i, '') || '导入的文档'
  let totalSize = 0
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name
    const path = safeZipPath(original)
    if (!path || path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store') || path === '.DS_Store') continue
    if (path === '.madang/manifest.json') {
      try {
        const manifest = JSON.parse(await entry.async('string')) as { format?: string; name?: string }
        if (manifest.format === 'madang-backup' && manifest.name?.trim()) backupName = manifest.name.trim()
      } catch { /* A malformed manifest does not invalidate otherwise portable Markdown files. */ }
      continue
    }
    if (/\.md(?:own)?$/i.test(path)) {
      const content = await entry.async('string')
      const size = new Blob([content]).size
      totalSize += size
      documents.push({ path, content: keepBinary ? content : undefined, size })
    } else if ((path.startsWith('assets/') || /(?:^|\/)\S+\.assets\//i.test(path)) && isImagePath(path)) {
      const blob = await entry.async('blob')
      totalSize += blob.size
      assets.push({ path, blob: keepBinary ? blob : undefined, type: blob.type || imageMime(path), size: blob.size })
    }
    if (totalSize > 512 * 1024 * 1024) throw new Error('备份解压后的内容超过 512 MB，已停止导入。')
  }
  if (!documents.length) throw new Error('备份包中没有找到 Markdown 文档。')
  return { name: safeBackupName(backupName), documents, assets, totalSize }
}

function safeZipPath(input: string) {
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.includes('\0')) throw new Error('备份中包含不安全的文件路径。')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) throw new Error('备份中包含越出目标目录的文件路径。')
  return segments.filter((segment) => segment && segment !== '.').join('/')
}

function safeBackupName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || '码档文档'
}

function isImagePath(path: string) {
  return /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path)
}

function imageMime(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' } as Record<string, string>)[extension || ''] || 'application/octet-stream'
}
