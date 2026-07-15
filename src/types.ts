export type FileNode = {
  name: string
  path: string
  relativePath: string
  kind: 'file' | 'directory'
  children?: FileNode[]
  createdAt?: number
  modifiedAt?: number
}

export type SearchResult = {
  path: string
  relativePath: string
  line: number
  column: number
  preview: string
}

export type TrashItem = {
  id: string
  name: string
  originalRelativePath: string
  kind: 'file' | 'directory'
  deletedAt: number
}

export type Heading = {
  level: number
  text: string
  line: number
  id: string
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
export type ViewMode = 'split' | 'editor' | 'preview'
export type ThemeMode = 'light' | 'dark' | 'system'
export type ColorTheme = 'ocean' | 'forest' | 'violet' | 'clay' | 'graphite'
export type CodeBlockMode = 'expanded' | 'limited'
export type CodeTheme = 'vscode' | 'jetbrains' | 'github' | 'nord'
export type CodeWrapMode = 'scroll' | 'wrap'

export type AppSettings = {
  theme: ThemeMode
  colorTheme: ColorTheme
  backgroundPanelOpacity: number
  codeBlockMode: CodeBlockMode
  codeBlockMaxHeight: number
  codeTheme: CodeTheme
  codeWrapMode: CodeWrapMode
  fontSize: number
  tabSize: number
  autoSaveDelay: number
  splitRatio: number
  leftSidebarWidth: number
  rightSidebarWidth: number
}
