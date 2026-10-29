<p align="center">
  <strong>Reader</strong><br>
  一个纯前端的中英双语阅读器（Markdown / PDF）
</p>

<p align="center">
  <img src="https://img.shields.io/badge/frontend-100%25-cfffcf?style=flat&labelColor=15181e" alt="100% frontend">
  <img src="https://img.shields.io/badge/backend-none-cfffcf?style=flat&labelColor=15181e" alt="No backend">
  <img src="https://img.shields.io/badge/bilingual-%E4%B8%AD%E8%8B%B1-cfffcf?style=flat&labelColor=15181e" alt="Chinese and English">
  <img src="https://img.shields.io/badge/format-Markdown%20%7C%20PDF-cfffcf?style=flat&labelColor=15181e" alt="Markdown and PDF">
  <img src="https://img.shields.io/badge/deploy-GitHub%20Pages%20%7C%20Vercel%20%7C%20Netlify-cfffcf?style=flat&labelColor=15181e" alt="Deploy anywhere">
  <img src="https://img.shields.io/badge/license-MIT-cfffcf?style=flat&labelColor=15181e" alt="MIT License">
  <img src="https://img.shields.io/badge/version-v0.0.6-cfffcf?style=flat&labelColor=15181e" alt="v0.0.6">
</p>

<p align="center">
  支持章节导航、阅读进度、笔记高亮、标签管理、多书切换、在线上传、PDF 阅读与自定义阅读背景。<br>
  无需后端，部署到 GitHub Pages / Vercel / Netlify 即可使用。
</p>

> **Reader** 把中英文 Markdown 与 PDF 变成一本可以真正读的书：章节导航、阅读进度、选中高亮、笔记与标签、多书切换、在线上传、PDF 阅读、自定义背景，全部在浏览器里完成。**没有后端，没有账号，部署即用。**

## ✨ 功能

| | |
|---|---|
| **📖 中英对照阅读** | 单栏中文、单栏英文、或左右并排对照，两栏滚动同步 |
| **🧭 章节导航** | 自动生成 TOC，滚动时高亮当前章节；PDF 支持内置书签的多级目录 |
| **📄 PDF 阅读** | 上传 PDF、读取书签目录（无书签按每 20 页降级分章）、页码跳转、缩放 / 适应宽度、进度恢复 |
| **🎨 阅读体验** | 字号调节、三套主题（浅色 / 护眼 / 深色）、顶部阅读进度条 |
| **🖼 自定义背景** | 上传 jpg/png/webp 作为全局阅读背景，cover 铺满不变形，遮罩浓度可调，支持清除 |
| **✍️ 选中即记** | 选中任意文字即可高亮或写笔记，支持跨段落选区；PDF 文本层同样可选中 |
| **🏷 标签管理** | 给笔记打标签、按标签筛选、从已有标签一键选择 |
| **🗑 批量删除** | 多选笔记，确认后批量删除 |
| **💾 本地持久化** | 笔记 / 书 / PDF / 背景保存到浏览器 IndexedDB，支持导出 / 导入 JSON 与完整备份 |
| **📚 多书管理** | 内置书 + 在线上传 zip / 文件夹 / PDF，随时切换 |
| **🌐 零后端** | 所有逻辑在浏览器完成，部署即用 |

## 🆕 v0.0.6 更新

- PDF 书籍：上传、书签目录解析、无书签降级、连续滚动阅读、页码/缩放、进度保存、PDF 文本层高亮与笔记；
- 按文件名判定中英语言（`en` / `zh` / `cn` 词边界匹配），结果落库，可在导入时手动覆盖；
- **上传入口统一**：zip 与 PDF 共用一个文件选择入口、一个上传队列、一个「导入书库」按钮；文件夹上传也会识别其中的 PDF；
- **可选 Windows 启动器**：`launcher/build.ps1` 把前端一键打包成单文件 `dist/Reader.exe`，双击启动本地服务并打开浏览器（无需 Python / Node / VSCode）；
- PDF 阅读工具栏显示「PDF · 单栏」说明（PDF 为单语文件，暂不支持中英对照）；Markdown 书仍支持双栏对照；
- 自定义阅读背景：上传、自动 cover 铺满、遮罩浓度、主题自适应、持久化、一键恢复默认；
- IndexedDB 升级到 v3（新增 PDF 与背景资源存储），旧版本浏览器数据自动迁移；完整备份包含 PDF 与背景；
- 新增「去品牌化」命名迁移（数据库名、localStorage 键、内置书 id）与迁移/回滚工具 `tools/db-migration.html`。

完整变更与回滚步骤见 [CHANGELOG.md](CHANGELOG.md)。

## ⚡ 工作原理

| 步骤 | 发生了什么 |
|---|---|
| **加载清单** | 读取 `content/library.json`，得到书目，再读取每本书的 `manifest.json` 得到章节顺序和标题 |
| **渲染章节** | 按清单里的 `zh` / `en` 路径 `fetch` Markdown，渲染到页面 |
| **PDF 渲染** | PDF 文件存入 IndexedDB；阅读时由 pdf.js（CDN 懒加载）渲染 canvas + 透明文本层，目录来自 PDF 内置书签（持久化在书籍记录里） |
| **阅读辅助** | 自动生成 TOC，滚动时高亮当前章节，顶部显示阅读进度条；PDF 按当前页显示进度 |
| **记录笔记** | 选中文字后，用 `TextQuoteSelector`（前后文 + 偏移）定位，存到 IndexedDB；PDF 笔记额外记录页码 |
| **阅读背景** | 背景图存 IndexedDB，启动时恢复为全屏 cover 图层，并按主题叠加可调遮罩 |

## 🚀 快速开始

### 本地运行

**方式一：Python 自带服务器**

```bash
cd 项目根目录
python3 -m http.server 8080
```

访问 `http://localhost:8080`。

**方式二：VS Code Live Server**

右键 `index.html` → **Open with Live Server**。

**方式三：Windows 双击启动（可选，无需 Python / VSCode）**

构建一次启动器后，双击 `dist/Reader.exe` 即可：

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build.ps1
# 可选：同时创建桌面快捷方式
powershell -ExecutionPolicy Bypass -File launcher\build.ps1 -CreateShortcut
```

- 双击后先弹出一个**深色状态窗口**（显示地址、状态，以及「打开阅读器 / 复制地址 / 退出」按钮），同时在后台尝试自动打开默认浏览器 `http://localhost:8080/`（与 `python -m http.server 8080` 同源，原书库/笔记可直接沿用）；
- 即使浏览器没有自动弹出，也能在窗口里点击地址或「打开阅读器」；关闭窗口会停止服务；
- 托盘图标常驻（Windows 11 可能收进 `^` 溢出区）；重复双击 exe 会通知已运行实例打开浏览器，不会启动第二个服务，也不会静默退出；
- 图标已替换为你提供的**浅色版本**（浅色圆角底 + 蓝色线条书本 + 折角书签），多尺寸 ICO 用于窗口/托盘/任务栏；预览见 `dist/reader-icon.png`，源文件 `launcher/icon-light.png`；
- exe 内嵌当前前端代码，修改代码后需重新运行 `build.ps1`；端口被占用时会自动换端口并在窗口里提示 Origin 数据隔离，构建/使用/升级/卸载细节见 [launcher/README.md](launcher/README.md)。

> 从旧版启动器升级时，请先在任务管理器结束旧的 `Reader.exe`，否则旧进程会占用 `dist/Reader.exe` 文件；升级后旧的无窗口进程也不会接管新版，需要重新双击新版。

> ⚠️ **注意**：不要直接双击 `index.html` 打开。`file://` 协议下 `fetch` 会被浏览器 CORS 拦截、IndexedDB 也不可用，页面会初始化失败；必须通过本地服务或上面的 exe 启动。

### 部署到 GitHub Pages

| 步骤 | 操作 |
|---|---|
| **1. 推送代码** | 把代码推送到 GitHub 仓库（Public） |
| **2. 开启 Pages** | 仓库 Settings → Pages → Source 选 **Deploy from a branch** |
| **3. 选择分支** | Branch 选 `main`，文件夹选 `/ (root)`，Save |
| **4. 等待生效** | 等待 1-2 分钟，访问 `https://<用户名>.github.io/<仓库名>/` |

> **注意**：代码里所有资源路径都是相对路径（不带前导 `/`），可以直接部署在子目录下。如果以后新增文件引用了绝对路径，会导致 GitHub Pages 下 404。

建议在仓库根目录加一个空的 `.nojekyll` 文件，避免 GitHub Pages 用 Jekyll 处理时忽略某些目录：

```bash
touch .nojekyll
git add .nojekyll
git commit -m "chore: disable jekyll"
git push
```

## 🗂 项目结构

```
.
├── index.html 主页面
├── styles.css 样式
├── pdf-reader.css PDF 阅读器样式
├── appearance.css 外观设置 / 阅读背景样式
├── app.js 应用逻辑（阅读器编排、笔记、书库、上传、备份）
├── i18n.js 多语言文案
├── lang-detect.js 文件名语言判定（纯函数，可单测）
├── pdf-chapters.js PDF 书签 → 章节（纯函数，可单测）
├── pdf-loader.js pdf.js 懒加载器（CDN + worker）
├── pdf-import.js PDF 校验与解析
├── pdf-reader.js PDF 连续滚动阅读器
├── background.js 阅读背景（校验 / 遮罩 / 图层）
├── package.json 仅测试与语法检查脚本（无运行时依赖）
├── tests/ Node 内置 node:test 单元测试 + PDF fixture
├── launcher/ Windows 双击启动器源码与构建脚本（产物 dist/Reader.exe 不入库）
├── tools/
│   ├──  manifest-generator.html Manifest 生成器（独立工具）
│   └── db-migration.html 数据库迁移 / 回滚工具
├── content/ 内置书的内容
│   ├── library.json 书库清单
│   ├── manifest.json 章节清单（由工具生成或手写）
│   ├── zh/ 中文 Markdown
│   └── en/ 英文 Markdown
└── CHANGELOG.md 版本记录与升级 / 回滚说明
```

## 📝 manifest.json 格式

`content/manifest.json` 定义章节顺序和标题：

```json
{
  "title": "前线部署工程师：人工智能时代的客户价值交付秘籍",
  "chapters": [
    {
      "id": "ch01",
      "titleZh": "第 1 章 FDE 的崛起",
      "titleEn": "Chapter 1 The Rise of FDE",
      "zh": "content/zh/ch01.md",
      "en": "content/en/ch01.md"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 章节唯一标识，建议用文件名（不含 `.md`） |
| `titleZh` | 中文标题 |
| `titleEn` | 英文标题 |
| `zh` / `en` | 相对于书根的路径（内置书就是相对于项目根） |

章节顺序按 `chapters` 数组顺序显示。

### 用工具自动生成

不想手写 manifest 时，打开 `tools/manifest-generator.html`：

1. 把书文件夹（里面有 `zh/` 和 `en/` 子目录）拖进页面
2. 工具会自动配对中英文文件、读取每个 `.md` 的 H1 作为标题
3. 在预览表里可以修改 ID、中文标题、英文标题
4. 点「下载 manifest.json」得到文件
5. 覆盖项目里的 `content/manifest.json`（或上传书籍时让工具自动处理）

> 建议生成后人工检查一遍，尤其是标题和章节顺序。

## 📤 上传书籍

部署后，点击工具栏的 **📥** 按钮：

| 方式 | 说明 |
|---|---|
| **选择文件** | 一个入口选择 **zip 或 PDF**（可多选，也可混合选择），系统按文件类型自动分流 |
| **选择文件夹** | 选择一个文件夹，自动识别其中的 Markdown 书（`manifest.json` / `zh/`、`en/` 目录）**以及文件夹内的 PDF** |

解析结果统一显示在下方列表（Markdown 书与 PDF 用不同的类型标签区分），勾选后点唯一的 **「导入书库」** 按钮即可；不再区分「临时预览」与「导入 PDF 到书库」两个按钮。

- zip / 文件夹里的 Markdown 书：有 `manifest.json` 直接用它，没有则根据 `zh/`、`en/` 目录下的 `.md` 自动生成章节；
- `「导出为仓库包」` **只对 Markdown 书生效**；如果勾选项包含 PDF，会提示改用「💾 完整备份」（PDF 暂不支持导出为仓库包）。

上传的书会保存在浏览器 IndexedDB 里，只在你当前浏览器可见，不会推到 GitHub。切换书用工具栏左侧的下拉选择器。

### PDF 书籍规则（v0.0.6）

| 项目 | 说明 |
|---|---|
| **校验** | 扩展名 `.pdf`、MIME、文件头 `%PDF-`、单册 ≤ 50MB、解析超时 60s；失败会给出明确提示 |
| **目录** | 优先读取 PDF 内置书签（outline）生成多级目录；章节含标题、层级、起始页、结束页 |
| **无书签降级** | 按每 20 页自动分章（如「第 1–20 页」），导入预览与进入阅读时都会提示 |
| **语言判定** | 以文件名判定：去掉扩展名后按非字母数字分词，精确匹配 `en`（英文）或 `zh` / `cn`（中文）；同时命中默认中文，都未命中默认中文；判定结果保存为 `lang` / `langSource`，导入时可手动覆盖 |
| **阅读** | 连续滚动 + 懒渲染（canvas + 透明文本层），页码显示/输入跳转、上一页/下一页、缩放 50%–300%、适应宽度 |
| **对照** | PDF 是单语文件，v0.0.6 为**单栏阅读**：PDF 模式工具栏会显示「PDF · 单栏」说明，暂不支持中英对照；Markdown 书仍支持双栏对照 |
| **进度** | 按书籍保存当前页，下次打开自动恢复 |
| **笔记 / 高亮** | PDF 文本层可直接选中文字做笔记/高亮，笔记记录页码，笔记列表按页排序并可跳转 |
| **不支持** | 扫描版（无文本层）只能阅读、做不了文字笔记；加密/带密码 PDF 不支持；跨页选中暂不支持 |
| **备份** | PDF 原始文件包含在「💾 完整备份」里；PDF 暂不支持导出为「仓库包」 |

## 🖼 自定义阅读背景

工具栏 **🎨 外观设置** → 阅读背景：

- 支持 jpg / jpeg / png / webp，单张 ≤ 8MB，会选择可解码的图片；长边超过 4096px 时自动等比压缩；
- 使用 `object-fit: cover` 铺满视口，横图 / 竖图 / 超宽图都不会变形或拉伸；
- 背景之上的遮罩浓度可在 0–100% 之间调整（默认 72%），遮罩颜色随浅色 / 护眼 / 深色主题自动适配，保证正文可读；
- 背景为**全局设置**，保存在 IndexedDB，刷新页面 / 重新打开浏览器后仍然生效；点击「清除自定义背景」恢复默认；
- 背景图片包含在「💾 完整备份」里。

## 💾 数据存储说明

所有数据都在浏览器本地（v0.0.6 起使用新的存储命名，旧版本数据会在首次打开时自动迁移）：

| 数据 | 存储位置 | 说明 |
|---|---|---|
| 笔记 | IndexedDB `notes` | 包括高亮、笔记、标签；PDF 笔记另含 `page` |
| 上传的书（Markdown） | IndexedDB `books` + `bookFiles` | 每本书独立存储 |
| PDF 文件 | IndexedDB `books`（元信息/目录）+ `bookBinary` | 原始 PDF 字节 |
| 阅读背景 | IndexedDB `assets` | 背景图 Blob |
| 设置 | localStorage `reader-settings` | 字号、主题、界面语言、PDF 缩放、背景遮罩浓度 |
| 上次阅读位置 | localStorage `reader-last-book` / `reader-last-chapter-*` | Markdown 书下次打开恢复 |
| PDF 阅读进度 | localStorage `reader-pdf-progress-*` | 按书保存当前页码 |

**不会跨设备同步。** 需要迁移时用笔记面板的导出 / 导入 JSON，或「💾 完整备份」（含 Markdown 书、PDF、背景图与笔记）。

> ⚠️ 清除浏览器数据（站点数据）会同时清空笔记、上传的书、PDF 和背景。建议定期备份。
>
> 从 v0.0.5 及更早版本升级时：应用会自动把旧版 localStorage 键与旧版 IndexedDB 数据库迁移到新命名（内置书 id 同时改为 `guide`），迁移完成后删除旧键 / 旧库。升级前建议先做一次完整备份。

## 🔧 浏览器兼容性

推荐：**Chrome / Edge 105+、Safari 17.2+、Firefox 140+**

| 能力 | 实现 / 降级 |
|---|---|
| 高亮 | CSS Custom Highlight API，老版本浏览器降级为 `mark` 方案（跨段落选区可能失效） |
| 上传文件夹 | `webkitdirectory`，现代浏览器均支持 |
| zip 解压 | JSZip（CDN 引入） |
| PDF 渲染 | pdf.js 4.2.67（CDN 动态加载，Apache-2.0），需要网络可达 jsDelivr；worker 优先转 Blob，失败时降级 CDN |
| PDF 中文文本层 | 使用同版本 CDN 的 cmaps / standard_fonts（中文 PDF 建议联网使用） |
| 背景图片压缩 | 优先 OffscreenCanvas，降级 `<canvas>`；WebP 需浏览器支持解码 |

## 🧩 已知限制

- 笔记高亮按 `TextQuoteSelector`（前后文 + 偏移）定位，正文被修改后高亮可能失效（笔记本身不丢）；
- PDF 不做 OCR：扫描版只能阅读，无法选中文字记笔记；
- PDF 为单语文件，暂不支持中英对照（阅读时工具栏会显示「PDF · 单栏」说明）；Markdown 书仍支持双栏对照；
- 加密 / 带密码的 PDF 暂不支持；
- PDF 暂不支持导出为「仓库包 / 内置书」，只参与完整备份；
- PDF 跨页选中暂不支持，请在单页内选择；
- 自定义背景为全局设置，暂不支持按书单独设置；
- 上传的书、PDF、背景和笔记都只存在当前浏览器，换设备 / 清缓存会丢；
- 标签是自由文本，不做去重合并；批量删除是硬删除，无回收站；
- v0.0.6 升级了 IndexedDB 版本，回滚到旧版本需按 [CHANGELOG.md](CHANGELOG.md) 的步骤备份、清库、恢复；
- Windows 启动器 exe 未做代码签名，从他人处获取时可能触发 SmartScreen 提示；页面渲染依赖 CDN（离线使用需另行 vendor 本地化）。

## ✅ 测试清单

单元测试（Node 18+，无需安装依赖）：

```bash
npm test            # node --test "tests/*.test.js"
npm run check       # 所有 js 文件的语法检查
```

<details>
<summary><strong>基础回归</strong></summary>

1. 内置书能正常加载、TOC、笔记、高亮、进度条
2. 之前版本的内置书笔记（`bookId: 'guide'`）自动出现在内置书下

</details>

<details>
<summary><strong>多书</strong></summary>

3. 工具栏左侧能看到书籍下拉框，默认显示内置书
4. 切换章节正常；切回同一本书能恢复上次章节

</details>

<details>
<summary><strong>上传入口（统一）</strong></summary>

5. 点 📥 → 弹窗只有「选择文件夹」和「选择文件（zip / PDF）」两个入口；空队列时「导入书库」置灰、「导出为仓库包」隐藏
6. 选择 zip → 显示章节预览 → 点唯一的「导入书库」→ 自动跳到新书第一章并正常渲染
7. 混合选择 zip + PDF → 两类内容同时出现在列表中 → 单次「导入书库」全部入库
8. 选择含 PDF 的文件夹 → 文件夹中的 Markdown 书与 PDF 都会被识别并可一并导入
9. 仅 PDF 队列时「导出为仓库包」隐藏；混合队列时该按钮只导出 Markdown（PDF 提示使用完整备份）
10. 切到 PDF 书再切回来，Markdown 书仍正常（双栏与 TOC 恢复）

</details>

<details>
<summary><strong>PDF</strong></summary>

11. 上传带书签的 PDF → 显示页数、目录项数、语言判定 → 导入后 TOC 呈现多级目录
12. PDF 阅读时工具栏显示「PDF · 单栏」徽标（点击有说明），不显示双栏切换
13. 点击目录项跳转到章节起始页；页码输入框可跳页；缩放与适应宽度正常
14. 阅读进度保存，刷新后恢复到同一页
15. 在 PDF 文本层选中文字 → 高亮 / 笔记；笔记面板显示「第 N 页」并可跳转
16. 上传无书签 PDF → 提示按每 20 页分章，TOC 与阅读正常
17. 文件名含 `en` 的 PDF 判定为英文、含 `zh` / `cn` 的判定为中文，导入预览与书库徽标一致
18. 非法 PDF、超过 50MB 的 PDF 有明确提示，页面不崩溃

</details>

<details>
<summary><strong>自定义背景</strong></summary>

19. 外观设置上传 jpg / png / webp 后立即生效，横图 / 竖图均 cover 铺满不变形
20. 调整遮罩浓度，浅色 / 护眼 / 深色主题下正文都可读
21. 刷新页面后背景与浓度仍生效；清除后恢复默认
22. 非法格式 / 超大图片有明确提示

</details>

<details>
<summary><strong>Windows 启动器（可选）</strong></summary>

23. 运行 `launcher/build.ps1` 生成 `dist/Reader.exe`，双击后浏览器自动打开且内置书正常渲染
24. 托盘图标右键可退出；重复双击 exe 只重新打开浏览器（单实例）
25. 修改端口/换机器后数据隔离提示正确（换端口需备份/恢复）

</details>

<details>
<summary><strong>数据与迁移</strong></summary>

26. 💾 完整备份后再恢复：Markdown 书、PDF、背景与笔记都在
27. 从 v0.0.5 升级：旧设置 / 进度 / 笔记 / 书自动迁移到新命名（含内置书 `bookId` → `guide`）
28. 打开 `tools/db-migration.html` 能看到数据库版本与各 store 记录数

</details>

## 📌 额外提醒

- 上传的书和笔记都存在**浏览器本地**，换浏览器 / 清缓存会丢。建议把导出的 JSON / 完整备份存在云盘。
- 如果以后想要「上传的书也推送到 GitHub 让别人看到」，那需要走 git 提交（把书放进 `content/` 目录 + 更新 manifest）。在线上传只解决「本地预览」，不改服务器内容。
- 部署到 GitHub Pages 后，`content/` 里的内容会随仓库更新，但**用户上传的书只在本浏览器生效**，不会被别人看到——这是纯前端应用的固有限制。如果你希望多用户共享书籍，需要后端。

## 🤝 贡献

欢迎提交 Issue 和 PR：修 bug、补文档、加功能都可以。如果新增了内容文件，记得同步更新 `content/manifest.json`。

## 📄 许可

MIT。PDF 渲染使用 [Mozilla PDF.js](https://github.com/mozilla/pdf.js)（Apache-2.0），通过 CDN 引入。
