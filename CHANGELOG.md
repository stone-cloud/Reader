# Changelog

本项目从 v0.0.6 起维护变更记录。版本号与工具栏「书库管理」弹窗右下角显示一致。

## v0.0.6

### 新增

- **PDF 书籍**
  - 上传入口支持 PDF（多选，单册 ≤ 50MB，校验扩展名 / MIME / 文件头 `%PDF-`）；
  - **上传入口统一**：zip 与 PDF 共用一个「选择文件」入口、一个上传队列、一个「导入书库」按钮；「选择文件夹」会同时识别文件夹中的 Markdown 书与 PDF；
  - 优先读取 PDF 内置书签（outline）生成多级目录，章节含标题、层级、起始页、结束页；
  - 无书签时按每 20 页自动分章，并在导入预览与阅读页给出提示；
  - 连续滚动阅读器：懒渲染 canvas + 文本层、页码显示与跳转、上一页/下一页、缩放（50%–300%）、适应宽度；
  - PDF 为单语文件，阅读时工具栏显示「PDF · 单栏」徽标说明暂不支持中英对照（Markdown 书双栏对照不受影响）；
  - 阅读进度按书籍保存（页码），下次打开自动恢复；
  - 目录持久化在书籍记录中，重开书籍不再重复解析；
  - 文本层支持选中文字 → 高亮 / 笔记，笔记记录页码，笔记列表按页排序并可跳转；
  - 中英语言判定（按文件名分词精确匹配 `en` / `zh` / `cn`），判定结果落库（`lang` + `langSource`），导入时可手动覆盖；
  - 加密 PDF、扫描版 PDF（无文本层）、损坏文件、超大文件、解析超时均有明确提示。
- **自定义阅读背景**
  - 工具栏「🎨 外观设置」中上传 jpg / jpeg / png / webp 背景（≤ 8MB，可解码校验，超长边自动压缩）；
  - `object-fit: cover` 铺满，横图 / 竖图 / 超宽图不变形；
  - 遮罩浓度 0–100% 可调（默认 72%），自动适配浅色 / 护眼 / 深色主题，保证正文可读；
  - 背景存 IndexedDB，刷新、重开浏览器后仍生效；支持一键恢复默认背景；
  - 背景为**全局**设置（后续可扩展为按书设置）。
- **数据与迁移**
  - IndexedDB 升级到 v3，新增 `bookBinary`（PDF 二进制）与 `assets`（背景资源）两个 object store，**只新增、不改旧记录**；
  - 完整备份（💾）与恢复现在包含 PDF 与背景图；
  - 书库删除书籍时同步清理该书的 PDF 数据；
  - 新增 `tools/db-migration.html` 数据库迁移 / 回滚工具（查看版本与统计、导出快照、清理 v0.0.6 数据、删除数据库）。
- **工程**
  - 新增 `lang-detect.js`、`pdf-chapters.js`（纯函数，UMD 可单测）、`pdf-loader.js`、`pdf-import.js`、`pdf-reader.js`、`background.js`；
  - 新增 `tests/`（Node 内置 `node:test`，无第三方依赖）：语言判定、PDF 章节构建、背景校验与遮罩；
  - 新增 `package.json`（仅 scripts，无运行时依赖）；
  - 新增可选 **Windows 一键启动器** `launcher/`：`build.ps1` 用系统自带 .NET Framework csc 编译出单文件 `dist/Reader.exe`（内嵌全部前端资源，约 0.96MB），双击即可启动本地服务并打开浏览器，无需安装 Python / Node / VSCode；默认 `localhost:8080`（与 python 静态服务同源），端口占用时自动换端口并在窗口中提示数据隔离；详见 `launcher/README.md`。
  - **启动器 r2 修复**（解决「双击 Reader.exe 没反应」）：
    - 双击后总是显示一个深色状态窗口（地址 / 打开阅读器 / 复制地址 / 退出），不再只依赖浏览器自动打开与托盘图标；关闭窗口 = 停止服务；
    - 浏览器自动打开改为后台线程执行，失败/卡住不会阻塞窗口，窗口会显示错误与可点击地址；
    - 单实例改用**命名管道**通知已运行实例打开浏览器；管道不可用时会退回默认端口打开浏览器，不再静默退出；
    - 端口/日志写入增加 `%TEMP%`、exe 同目录兜底（此前 AppData 写入失败时二次双击会因读不到 port.txt 而静默）；
    - 图标替换为**用户提供的浅色版本**（浅色圆角底 + 蓝色线条书本 + `>` + 折角书签），源文件 `launcher/icon-light.png`（1024×1024 透明 PNG），构建生成 16–256px 七种尺寸 ICO，窗口/托盘/任务栏统一使用；预览 `dist/reader-icon.png`；
    - 新增 `--no-ui` / `--force-new` 调试参数，方便自动化验证。
  - 升级注意：旧版启动器进程会锁定 `dist/Reader.exe`，需先在任务管理器结束旧的 `Reader.exe` 再运行新版。

### 变更（去品牌化，不保留旧命名）

- 数据库名：`fde-reader` → `reader-db`；
- localStorage 键：`fde-settings` / `fde-last-book` / `fde-view` / `fde-last-backup` / `fde-last-chapter-<id>` → `reader-settings` / `reader-last-book` / `reader-view` / `reader-last-backup` / `reader-last-chapter-<id>`；
- 内置书 id：`fde` → `guide`（`content/library.json` 与旧笔记 `bookId` 一并迁移）；
- 新增 PDF 进度键：`reader-pdf-progress-<bookId>`。

> 升级时应用会**自动迁移**上述旧 localStorage 键与旧 IndexedDB 数据库（`fde-reader`）的数据，迁移成功后删除旧键/旧库；旧笔记的 `bookId: 'fde'` 会映射为 `guide`。迁移不会修改书籍正文内容。

### 修复

- **上传弹窗按钮状态**：此前「临时预览 / 导入 PDF」是两套并行队列，禁用状态的 `primary` 按钮缺少置灰样式，看起来可点但实际无效；现已合并为单一「导入书库」按钮，并补齐禁用样式、按队列类型显隐「导出为仓库包」；
- **PDF 对照误导**：PDF 模式隐藏双栏切换而无说明，现改为显示「PDF · 单栏」徽标（点击有说明），明确 PDF 暂不支持中英对照；
- 初始化失败时不再依赖 `.markdown-body` 是否被 PDF 视图替换，统一恢复 pane 结构，避免白屏；
- 新增 `unhandledrejection` 兜底提示，异步异常不再静默失败；
- 备份元数据版本号与实际版本一致（`v0.0.6`）。

### 依赖

- 运行时新增 CDN 依赖 `pdfjs-dist@4.2.67`（Apache-2.0，固定版本；ESM 单文件 + worker Blob 加载）。选择理由：维护活跃、许可证兼容，4.2.67 为修复 CVE-2024-4367 的最低安全版本；与项目现有 CDN 依赖（markdown-it / DOMPurify / JSZip）方式一致。
- 无新增 npm 运行时依赖；测试使用 Node 内置 `node:test`。

### 升级 / 回滚

- **升级**：直接部署新版本即可，首次打开自动完成 IndexedDB v2 → v3 与旧命名迁移；建议升级前先用 💾 做一次完整备份。
- **回滚**：IndexedDB 不支持降版本，回滚需按以下步骤（详见 `tools/db-migration.html` 页面提示）：
  1. 在 v0.0.6 中做一次 💾 完整备份（含 PDF 与背景）；
  2. 在书库管理中删除 PDF 书籍、在外观设置中恢复默认背景；
  3. 切回 v0.0.5 代码重新部署；
  4. 打开 `tools/db-migration.html`，点「删除数据库」（旧代码无法打开 v3 数据库，会报 VersionError）；
  5. 旧版本打开后，用备份恢复笔记 / 书籍（旧版本会自动忽略 `pdfs/` 与 `assets/` 条目）。

## v0.0.5

- 多书管理、书库管理（导出仓库包 / 删除 / 刷新）、完整备份与恢复、笔记标签与批量删除、语言选择器（v0.0.6 前置提交）。

## v0.0.4 及更早

- 见 git 历史与 README。
