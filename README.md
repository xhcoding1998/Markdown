# MD来了

一款使用 Vue 3、TypeScript、CodeMirror 6 与 Tauri 2 构建的本地优先 Markdown 编辑器，同时支持 Web 与桌面客户端。

## 当前能力

- 本地工作区与 Markdown 文件树
- CodeMirror Markdown 编辑与常用格式工具栏
- 实时预览、代码高亮、表格与安全 HTML 过滤
- 标题大纲、字数/字符/行数与阅读时间统计
- 工作区文件名和正文搜索
- 自动保存、新建文件和 HTML 导出
- 双栏、仅编辑、仅预览模式
- 浅色、深色和跟随系统主题
- Web 端 IndexedDB 持久化虚拟工作区
- Chrome/Edge File System Access API 本地文件夹读写
- Rust 侧工作区路径隔离、临时文件保存和系统回收站

Web 端首次访问会创建一个持久化示例工作区。Chrome/Edge 用户还可以授权打开本地文件夹；其他浏览器使用 IndexedDB 工作区。Tauri 桌面模式使用原生文件系统。

## 开发

```bash
npm install
npm run dev
```

浏览器访问 `http://127.0.0.1:1420`。

## Web 部署

```bash
npm run build
```

将生成的 `dist` 目录部署到任意静态网站服务即可。构建使用相对资源路径，可部署在域名根目录或子目录。

生产环境需要使用 HTTPS，浏览器才会开放本地目录授权和剪贴板等安全 API。Web 端数据默认保存在当前域名对应的 IndexedDB 中，清除站点数据会同时清除虚拟工作区；直接打开的本地文件夹不受此影响。

## 桌面模式

Windows 需要先安装 Rust stable MSVC 工具链、Microsoft C++ Build Tools（Desktop development with C++）以及 WebView2 Runtime。安装完成后运行：

```bash
npm run tauri dev
```

生成安装包：

```bash
npm run tauri build
```

## 文档

- [产品需求文档](./PRD.md)
- [技术与界面设计](./DESIGN.md)
