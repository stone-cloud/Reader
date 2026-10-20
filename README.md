# Reader

一个纯前端的中英双语 Markdown 阅读器，支持章节导航、阅读进度、笔记高亮、标签管理、多书切换与在线上传。无需后端，部署到 GitHub Pages / Vercel / Netlify 即可使用。

## ✨ 功能

- 📖 **中英对照阅读**：单栏中文、单栏英文、或左右并排对照，两栏滚动同步
- 🧭 **章节导航**：自动生成 TOC，滚动时高亮当前章节
- 🎨 **阅读体验**：字号调节、三套主题（浅色 / 护眼 / 深色）、顶部阅读进度条
- ✍️ **选中即记**：选中任意文字即可高亮或写笔记，支持跨段落选区
- 🏷 **标签管理**：给笔记打标签、按标签筛选、从已有标签一键选择
- 🗑 **批量删除**：多选笔记，确认后批量删除
- 💾 **本地持久化**：笔记保存到浏览器 IndexedDB，支持导出/导入 JSON
- 📚 **多书管理**：内置书 + 在线上传 zip/文件夹，随时切换
- 🌐 **零后端**：所有逻辑在浏览器完成，部署即用

## 🗂 项目结构

```
.
├── index.html 主页面
├── styles.css 样式
├── app.js 应用逻辑
├── content/ 内置书的内容
│ ├── manifest.json 章节清单（由工具生成或手写）
│ ├── zh/ 中文 Markdown
│ └── en/ 英文 Markdown
└── tools/
└── manifest-generator.html Manifest 生成器（独立工具）
```

## 本地运行

**方式一：Python 自带服务器**

```bash
cd 项目根目录
python3 -m http.server 8080

访问 http://localhost:8080
```

**方式二：VS Code Live Server**

右键 index.html → Open with Live Server

⚠️ 不要直接双击 index.html 打开，file:// 协议下 fetch 会被浏览器 CORS 拦截，页面会初始化失败。

🌍 部署到 GitHub Pages
把代码推送到 GitHub 仓库（Public）

仓库 Settings → Pages → Source 选 Deploy from a branch

Branch 选 main，文件夹选 / (root)，Save

等待 1-2 分钟，访问 https://<用户名>.github.io/<仓库名>/

注意：代码里所有资源路径都是相对路径（不带前导 /），可以直接部署在子目录下。如果以后新增文件引用了绝对路径，会导致 GitHub Pages 下 404。
建议：在仓库根目录加一个空的 .nojekyll 文件，避免 GitHub Pages 用 Jekyll 处理时忽略某些目录：

bash
touch .nojekyll
git add .nojekyll
git commit -m "chore: disable jekyll"
git push
📝 manifest.json 格式
content/manifest.json 定义章节顺序和标题：

json
{
  "title": "FDE - The Guidance Book",
  "chapters": [
    {
      "id": "ch01",
      "titleZh": "第 1 章 什么是前向部署工程师",
      "titleEn": "Chapter 1 - What is an FDE",
      "zh": "content/zh/ch01.md",
      "en": "content/en/ch01.md"
    }
  ]
}
id：章节唯一标识，建议用文件名（不含 .md）

zh / en：相对于书根的路径（内置书就是相对于项目根）

章节顺序按 chapters 数组顺序显示

用工具自动生成
不想手写 manifest 时，打开 tools/manifest-generator.html：

把书文件夹（里面有 zh/ 和 en/ 子目录）拖进页面

工具会自动配对中英文文件、读取每个 md 的 H1 作为标题

在预览表里可以修改 ID、中文标题、英文标题

点「下载 manifest.json」得到文件

覆盖项目里的 content/manifest.json（或上传书籍时让工具自动处理）

建议生成后人工检查一遍，尤其是标题和章节顺序。

📤 上传书籍
部署后，点击工具栏的 📚+ 按钮：

选择 zip：把书文件夹压缩成 zip 后上传

选择文件夹：直接选中包含 zh/ 和 en/ 子目录的文件夹

如果文件夹里有 manifest.json，直接用它；没有的话，工具会根据 zh/ 和 en/ 目录下的 md 文件自动生成。

上传的书会保存在浏览器 IndexedDB 里，只在你当前浏览器可见，不会推到 GitHub。切换书用工具栏左侧的下拉选择器。

💾 数据存储说明
所有数据都在浏览器本地：

数据	存储位置	说明
笔记	IndexedDB notes	包括高亮、笔记、标签
上传的书	IndexedDB books + bookFiles	每本书独立存储
设置	localStorage fde-settings	字号、主题
上次阅读位置	localStorage fde-last-book / fde-last-chapter-*	下次打开恢复
不会跨设备同步。需要迁移时用笔记面板的导出/导入 JSON 功能。

清除浏览器数据（站点数据）会同时清空笔记和上传的书。建议定期导出备份。

🔧 浏览器兼容性
推荐：Chrome / Edge 105+、Safari 17.2+、Firefox 140+

高亮用 CSS Custom Highlight API，老版本浏览器会降级为 mark 方案（跨段落选区可能失效）

上传文件夹用 webkitdirectory，现代浏览器均支持

zip 解压用 JSZip（CDN 引入）

🧩 已知限制
笔记高亮按 TextQuoteSelector（前后文 + 偏移）定位，正文被修改后高亮可能失效（笔记本身不丢）

上传的书不能重命名（暂未实现），想改可以删掉重新导入

标签是自由文本，不做去重合并（后续可能加标签管理）

批量删除是硬删除，无回收站

📄 许可
MIT

text

---

## 6. 测试清单

**基础回归**
1. 内置书能正常加载、TOC、笔记、高亮、进度条
2. 之前的旧笔记自动出现在内置书下（`bookId: 'fde'`）

**多书**
3. 工具栏左侧能看到书籍下拉框，默认显示「FDE - The Guidance Book (内置)」
4. 切换章节正常；切回同一本书能恢复上次章节

**上传 zip**
5. 点 📚+ → 选 zip → 显示章节预览 → 输入书名 → 导入
6. 导入后自动跳到新书第一章，能正常渲染
7. 切回内置书，再切回来，上传的书还在

**上传文件夹**
8. 同样能导入；`manifest.json` 存在时优先使用
9. 缺 manifest 时自动生成，章节标题取 H1

**manifest 生成器**
10. 打开 `tools/manifest-generator.html`，拖入书文件夹 → 表格显示 → 修改标题 → 下载
11. 下载的 JSON 放到项目 `content/manifest.json` 位置，内置书能读到新内容（记得先清 IndexedDB 里的 `fde` 记录或换浏览器测）

**笔记隔离**
12. 在书 A 记笔记，切到书 B，笔记面板只显示书 B 的笔记
13. 切回书 A，笔记都在

---

## 7. 额外提醒

- 上传的书和笔记都存在**浏览器本地**，换浏览器/清缓存会丢。建议把导出的 JSON 存在云盘。
- 如果以后想要「上传的书也推送到 GitHub 让别人看到」，那需要走 git 提交（把书放进 `content/` 目录 + 更新 manifest）。在线上传只解决"本地预览"，不改服务器内容。
- 部署到 GitHub Pages 后，`content/` 里的内容会随仓库更新，但**用户上传的书只在本浏览器生效**，不会被别人看到——这是纯前端应用的固有限制。如果你希望多用户共享书籍，需要后端。