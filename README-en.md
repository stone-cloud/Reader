<p align="center">
  <strong>Reader</strong><br>
  A pure front-end bilingual Chinese-English reader (Markdown / PDF)
</p>

<p align="center">
  <img src="https://img.shields.io/badge/frontend-100%25-cfffcf?style=flat&labelColor=15181e" alt="100% frontend">
  <img src="https://img.shields.io/badge/backend-none-cfffcf?style=flat&labelColor=15181e" alt="No backend">
  <img src="https://img.shields.io/badge/bilingual-Chinese%20%7C%20English-cfffcf?style=flat&labelColor=15181e" alt="Chinese and English">
  <img src="https://img.shields.io/badge/format-Markdown%20%7C%20PDF-cfffcf?style=flat&labelColor=15181e" alt="Markdown and PDF">
  <img src="https://img.shields.io/badge/deploy-GitHub%20Pages%20%7C%20Vercel%20%7C%20Netlify-cfffcf?style=flat&labelColor=15181e" alt="Deploy anywhere">
  <img src="https://img.shields.io/badge/license-MIT-cfffcf?style=flat&labelColor=15181e" alt="MIT License">
  <img src="https://img.shields.io/badge/version-v0.0.6-cfffcf?style=flat&labelColor=15181e" alt="v0.0.6">
</p>

<p align="center">
  Chapter navigation, reading progress, note highlights, tag management, multi-book switching, online uploads, PDF reading, and custom reading backgrounds.<br>
  No backend required. Deploy to GitHub Pages, Vercel, or Netlify and it works.
</p>

**Reader** turns Chinese and English Markdown and PDF files into a book you can actually read: chapter navigation, reading progress, selection highlights, notes and tags, multi-book switching, online uploads, PDF reading, and custom backgrounds, all in the browser. **No backend, no account, deploy and use.**

## Features

| Feature | Description |
|---|---|
| **Bilingual reading** | Single-column Chinese, single-column English, or side-by-side comparison with synchronized scrolling |
| **Chapter navigation** | Automatically generated TOC with current chapter highlighted while scrolling; multi-level TOC from PDF bookmarks |
| **PDF reading** | Upload PDFs, extract bookmark outlines (fallback: split every 20 pages), jump by page, zoom / fit width, restore progress |
| **Reading experience** | Font size adjustment, three themes (light / eye-care / dark), and a top reading progress bar |
| **Custom background** | Upload jpg/png/webp as a global reading background, cover fill without distortion, adjustable overlay, easy reset |
| **Select to annotate** | Select any text to highlight or write a note, including cross-paragraph selections; PDF text layers work too |
| **Tag management** | Add tags to notes, filter by tag, and pick from existing tags with one click |
| **Batch delete** | Select multiple notes and delete them in bulk after confirmation |
| **Local persistence** | Notes / books / PDFs / backgrounds are saved to browser IndexedDB, with JSON export / import and full backup |
| **Multi-book management** | Built-in book plus online upload of zip / folder / PDF, switch anytime |
| **Zero backend** | All logic runs in the browser, ready to deploy |

## What's new in v0.0.6

- PDF books: upload, bookmark outline parsing, page-based fallback, continuous scrolling, page/zoom controls, saved progress, PDF text-layer highlights and notes;
- Language detection from filename (`en` / `zh` / `cn`, word-boundary matching), persisted with the book and manually overridable during import;
- **Unified upload entry**: zip and PDF share one file picker, one upload queue, and one "Import to library" button; folder uploads also detect PDFs inside;
- **Optional Windows launcher**: `launcher/build.ps1` packages the front end into a single `dist/Reader.exe`; double-click starts the local server and opens the browser (no Python / Node / VSCode required);
- PDF reading shows a "PDF · Single column" badge (PDFs are single-language; side-by-side comparison is not supported yet), while Markdown books still support it;
- Custom reading background: upload, cover fill, overlay strength, theme-aware, persistent, reset to default;
- IndexedDB upgraded to v3 (new stores for PDF and background assets) with automatic migration of previous browser data; full backup now includes PDFs and backgrounds;
- Naming migration plus a migration / rollback tool in `tools/db-migration.html`.

See [CHANGELOG.md](CHANGELOG.md) for the full change list and rollback steps.

## How it works

| Step | What happens |
|---|---|
| **Load manifest** | Read `content/library.json`, then each book's `manifest.json` for chapter order and titles |
| **Render chapters** | `fetch` the Markdown paths from `zh` / `en` in the manifest and render them into the page |
| **Render PDF** | PDF bytes are stored in IndexedDB; at read time pdf.js (lazy-loaded from CDN) renders canvas + transparent text layer; the outline comes from PDF bookmarks and is persisted with the book |
| **Reading aids** | Auto-generated TOC, active chapter highlighting while scrolling, top progress bar; PDF progress is page-based |
| **Notes** | After selecting text, a `TextQuoteSelector` (context + offset) locates it and the note is stored in IndexedDB; PDF notes also record the page number |
| **Reading background** | The background image is stored in IndexedDB, restored at startup as a full-screen cover layer with a theme-aware, adjustable overlay |

## Quick start

### Run locally

**Option 1: Python built-in server**

```bash
cd project-root
python3 -m http.server 8080
```

Open `http://localhost:8080`.

**Option 2: VS Code Live Server**

Right-click `index.html` → **Open with Live Server**.

**Option 3: Windows one-click launcher (optional, no Python / VSCode)**

Build the launcher once, then double-click `dist/Reader.exe`:

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build.ps1
# optional: also create a desktop shortcut
powershell -ExecutionPolicy Bypass -File launcher\build.ps1 -CreateShortcut
```

- Double-click shows a **dark status window** (address + "Open reader / Copy address / Exit" buttons) and also tries to open `http://localhost:8080/` in the default browser (same origin as `python -m http.server 8080`, so existing library/notes keep working);
- If the browser does not open automatically, the window still lets you click the address or "Open reader"; closing the window stops the service;
- A tray icon stays resident (Windows 11 may hide it in the `^` overflow); double-clicking the exe again asks the running instance to open the browser instead of silently exiting or starting a second server;
- Icon replaced with your **light version** (light rounded tile + blue line-art book + folded bookmark); multi-size ICO for window/tray/taskbar; preview at `dist/reader-icon.png`, source at `launcher/icon-light.png`;
- The exe embeds the front-end snapshot, so re-run `build.ps1` after changing the code; if port 8080 is busy it falls back to another port and shows it in the window. Build/usage/upgrade/uninstall details: [launcher/README.md](launcher/README.md).

> When upgrading from the previous launcher, end the old `Reader.exe` in Task Manager first; otherwise it keeps `dist/Reader.exe` locked. Old headless instances do not hand over to the new version — quit them and start the new exe again.

> ⚠️ **Note**: Don't open `index.html` by double-clicking it. Under `file://`, `fetch` is blocked by browser CORS and IndexedDB is unavailable, so the page fails to initialize; use a local server or the launcher above.

### Deploy to GitHub Pages

| Step | Action |
|---|---|
| **1. Push code** | Push the code to a GitHub repository (Public) |
| **2. Enable Pages** | Repository Settings → Pages → Source: **Deploy from a branch** |
| **3. Choose branch** | Branch: `main`, folder: `/ (root)`, Save |
| **4. Wait** | Wait 1-2 minutes, then visit `https://<username>.github.io/<repo>/` |

> **Note**: All resource paths are relative (no leading `/`), so the site can be served from a sub-directory. Absolute paths would cause 404 on GitHub Pages.

Consider adding an empty `.nojekyll` file to the repository root so GitHub Pages does not process the site with Jekyll:

```bash
touch .nojekyll
git add .nojekyll
git commit -m "chore: disable jekyll"
git push
```

## Project structure

```
.
├── index.html main page
├── styles.css global styles
├── pdf-reader.css PDF reader styles
├── appearance.css appearance / reading background styles
├── app.js application logic (reader orchestration, notes, library, uploads, backup)
├── i18n.js translations
├── lang-detect.js language detection from filename (pure, unit-testable)
├── pdf-chapters.js PDF outline → chapters (pure, unit-testable)
├── pdf-loader.js lazy pdf.js loader (CDN + worker)
├── pdf-import.js PDF validation and parsing
├── pdf-reader.js continuous-scroll PDF reader
├── background.js reading background (validation / overlay / layer)
├── package.json test and syntax-check scripts only (no runtime deps)
├── tests/ built-in node:test unit tests + PDF fixtures
├── launcher/ Windows one-click launcher source and build script (dist/Reader.exe is not committed)
├── tools/
│   ├──  manifest-generator.html manifest generator (standalone tool)
│   └── db-migration.html database migration / rollback tool
├── content/ built-in book content
│   ├── library.json book library manifest
│   ├── manifest.json chapter manifest (generated by the tool or hand-written)
│   ├── zh/ Chinese Markdown
│   └── en/ English Markdown
└── CHANGELOG.md release notes and upgrade / rollback instructions
```

## manifest.json format

`content/manifest.json` defines chapter order and titles:

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

| Field | Description |
|---|---|
| `id` | Unique chapter id, usually the filename without `.md` |
| `titleZh` | Chinese title |
| `titleEn` | English title |
| `zh` / `en` | Paths relative to the book root (for built-in books, relative to the project root) |

Chapters are displayed in `chapters` array order.

### Generate it with the tool

If you don't want to write the manifest by hand, open `tools/manifest-generator.html`:

1. Drag a book folder (containing `zh/` and `en/` sub-folders) into the page
2. The tool pairs Chinese/English files and reads each `.md` H1 as the title
3. Edit ids and titles in the preview table
4. Click "下载 manifest.json" to download the file
5. Replace `content/manifest.json` (or let the upload flow handle it)

> Review the generated titles and chapter order manually.

## Upload books

Deployed, click the **📥** button in the toolbar:

| Method | Description |
|---|---|
| **Choose files** | One entry for **zip or PDF** (multiple allowed, mixable); files are routed by type automatically |
| **Choose folder** | Select a folder; Markdown books (`manifest.json` / `zh/`, `en/` folders) **and PDFs inside the folder** are detected automatically |

Parsed items appear in one list (Markdown books and PDFs are labelled by type); check the ones you want and click the single **"Import to library"** button. There is no longer a separate "Preview only" and "Import PDF" pair of buttons.

- Markdown inside zip / folder: `manifest.json` is used when present, otherwise chapters are inferred from `.md` files under `zh/` and `en/`;
- **"Export as repo package" only applies to Markdown books**; if PDFs are selected you get a hint to use the "💾 full backup" instead (PDF export as a repo package is not supported yet).

Uploaded books are stored in browser IndexedDB and are visible only in your current browser; nothing is pushed to GitHub. Switch books with the dropdown on the left of the toolbar.

### PDF rules (v0.0.6)

| Item | Description |
|---|---|
| **Validation** | `.pdf` extension, MIME, `%PDF-` magic bytes, ≤ 50MB per file, 60s parse timeout; failures show clear messages |
| **Outline** | Read the built-in bookmark outline first, producing a multi-level TOC with title, level, start page, and end page |
| **Fallback** | Without bookmarks, split every 20 pages (e.g. "Pages 1–20") and show a hint in the import preview and while reading |
| **Language detection** | From the filename: strip the extension, split on non-alphanumerics, match tokens `en` (English) or `zh` / `cn` (Chinese); conflicts and no-match default to Chinese; stored as `lang` / `langSource`, manually overridable during import |
| **Reading** | Continuous scroll with lazy rendering (canvas + transparent text layer), page display/input, previous/next page, zoom 50%–300%, fit width |
| **Comparison** | PDFs are single-language files; v0.0.6 reads them in **single-column mode** and shows a "PDF · Single column" badge. Side-by-side comparison is not supported yet; Markdown books still support it |
| **Progress** | Saved per book as the current page, restored on reopen |
| **Notes / highlights** | Select text in the PDF text layer to highlight or annotate; notes record the page number, the notes list is sorted by page and can jump |
| **Not supported** | Scanned PDFs (no text layer) can only be read, not annotated; encrypted / password-protected PDFs; cross-page selections |
| **Backup** | The original PDF is included in the "💾 full backup"; PDF export as a "repo package" is not supported in this version |

## Custom reading background

Toolbar **🎨 Appearance** → Reading background:

- Supports jpg / jpeg / png / webp, ≤ 8MB per image; the image must decode successfully. Images with a long edge > 4096px are scaled down proportionally;
- Uses `object-fit: cover` to fill the viewport; landscape, portrait, and ultra-wide images are never stretched or distorted;
- Overlay strength is adjustable from 0–100% (default 72%); the overlay color adapts to the light / eye-care / dark themes so the text stays readable;
- The background is **global**, stored in IndexedDB, and persists across reloads and browser restarts; click "Reset to default background" to remove it;
- The background image is included in the "💾 full backup".

## Data storage

All data lives in the browser (v0.0.6 uses new storage names; data from previous versions is migrated automatically on first open):

| Data | Storage | Notes |
|---|---|---|
| Notes | IndexedDB `notes` | Highlights, notes, tags; PDF notes also carry `page` |
| Uploaded books (Markdown) | IndexedDB `books` + `bookFiles` | One record per book |
| PDF files | IndexedDB `books` (metadata/TOC) + `bookBinary` | Raw PDF bytes |
| Reading background | IndexedDB `assets` | Background image Blob |
| Settings | localStorage `reader-settings` | Font size, theme, UI language, PDF zoom, background overlay |
| Last reading position | localStorage `reader-last-book` / `reader-last-chapter-*` | Restored for Markdown books |
| PDF reading progress | localStorage `reader-pdf-progress-*` | Current page per book |

**Nothing is synced across devices.** To migrate, use the notes JSON export / import, or the "💾 full backup" (Markdown books, PDFs, background, and notes).

> ⚠️ Clearing browser site data removes notes, uploaded books, PDFs, and the background. Back up regularly.
>
> When upgrading from v0.0.5 or earlier, the app migrates old localStorage keys and the old IndexedDB database to the new names (the built-in book id becomes `guide`), then removes the old keys / database. Do a full backup before upgrading.

## Browser compatibility

Recommended: **Chrome / Edge 105+, Safari 17.2+, Firefox 140+**

| Capability | Implementation / fallback |
|---|---|
| Highlights | CSS Custom Highlight API; older browsers fall back to `<mark>` (cross-paragraph ranges may fail) |
| Folder upload | `webkitdirectory`, supported in all modern browsers |
| zip extraction | JSZip (loaded from CDN) |
| PDF rendering | pdf.js 4.2.67 (lazy-loaded from CDN, Apache-2.0); requires network access to jsDelivr; worker is converted to a Blob first and falls back to CDN |
| Chinese PDF text layer | Uses cmaps / standard_fonts from the same CDN version (network recommended for Chinese PDFs) |
| Background image compression | OffscreenCanvas first, `<canvas>` fallback; WebP requires browser support |

## Known limitations

- Highlights are anchored with `TextQuoteSelector` (context + offset); editing the text can invalidate highlights (notes are kept);
- No OCR: scanned PDFs can be read but not text-selected for notes;
- PDFs are single-language files, so side-by-side comparison is not supported yet (the toolbar shows a "PDF · Single column" badge); Markdown books still support it;
- Encrypted / password-protected PDFs are not supported;
- PDFs cannot be exported as a "repo package / built-in book" yet; they only participate in full backups;
- Cross-page PDF selection is not supported; select within a single page;
- The custom background is global (per-book backgrounds are not supported yet);
- Uploaded books, PDFs, backgrounds, and notes live only in the current browser and are lost when site data is cleared;
- Tags are free text with no deduplication; batch delete is permanent (no recycle bin);
- v0.0.6 upgrades the IndexedDB version; rolling back to an older release requires backup, database deletion, and restore as described in [CHANGELOG.md](CHANGELOG.md);
- The Windows launcher exe is unsigned (SmartScreen may warn when obtained from others); page rendering still depends on the CDN (fully offline use would require vendoring the libraries).

## Test checklist

Unit tests (Node 18+, no dependencies to install):

```bash
npm test            # node --test "tests/*.test.js"
npm run check       # syntax-check all js files
```

<details>
<summary><strong>Basic regression</strong></summary>

1. The built-in book loads with TOC, notes, highlights, and progress bar
2. Notes from previous versions appear under the built-in book (`bookId: 'guide'`)

</details>

<details>
<summary><strong>Multiple books</strong></summary>

3. The book dropdown is visible on the left of the toolbar and shows the built-in book by default
4. Switching chapters works; switching back restores the last chapter

</details>

<details>
<summary><strong>Unified upload entry</strong></summary>

5. Click 📥 → the dialog has only "Choose folder" and "Choose files (zip / PDF)"; with an empty queue "Import to library" is greyed out and "Export as repo package" is hidden
6. Choose a zip → chapter preview → click the single "Import to library" → the app jumps to the first chapter and renders it
7. Mix zip + PDF in one selection → both appear in the list → a single "Import to library" imports them all
8. Choose a folder containing PDFs → the Markdown books and the PDFs inside are both detected and importable together
9. With a PDF-only queue "Export as repo package" is hidden; with a mixed queue it exports only Markdown (PDFs show a hint to use the full backup)
10. Switch to a PDF book and back; the Markdown book still renders (two-pane view and TOC restored)

</details>

<details>
<summary><strong>PDF</strong></summary>

11. Upload a PDF with bookmarks → page count, outline item count, and language are shown → after import the TOC shows a multi-level outline
12. In PDF mode the toolbar shows a "PDF · Single column" badge (click for an explanation) and hides the two-pane switch
13. Clicking an outline item jumps to the chapter start page; the page input jumps; zoom and fit width work
14. Reading progress is saved and restored after reload
15. Select text in the PDF text layer → highlight / note; the notes panel shows "Page N" and can jump
16. Upload a PDF without bookmarks → a hint about the 20-page fallback appears; TOC and reading work
17. A PDF whose filename contains `en` is detected as English; `zh` / `cn` as Chinese; the import preview and library badge agree
18. Invalid PDFs and PDFs over 50MB show clear messages and do not crash the page

</details>

<details>
<summary><strong>Custom background</strong></summary>

19. Uploading jpg / png / webp in Appearance takes effect immediately; landscape and portrait images fill with cover without distortion
20. Adjust the overlay; text remains readable in light / eye-care / dark themes
21. After reload the background and overlay persist; clearing restores the default
22. Invalid formats / oversized images show clear messages

</details>

<details>
<summary><strong>Windows launcher (optional)</strong></summary>

23. Run `launcher/build.ps1`, double-click `dist/Reader.exe`, and the built-in book renders in the opened browser
24. The tray icon can quit the app; double-clicking the exe again only reopens the browser (single instance)
25. When the port changes, the origin/data-isolation warning is shown (backup/restore needed to move data)

</details>

<details>
<summary><strong>Data and migration</strong></summary>

26. 💾 full backup then restore: Markdown books, PDFs, background, and notes all come back
27. Upgrading from v0.0.5: old settings / progress / notes / books are migrated to the new names (including the built-in `bookId` → `guide`)
28. `tools/db-migration.html` shows the database version and per-store record counts

</details>

## Extra notes

- Uploaded books and notes live **in the browser only**; switching browsers or clearing cache loses them. Keep exported JSON / full backups in cloud storage.
- If you want uploaded books to be visible to others via GitHub, commit them into `content/` and update the manifest. Online uploads are for local preview only.
- After deploying to GitHub Pages, `content/` updates with the repository, but **uploaded books are local to each browser** and invisible to others — an inherent limitation of a pure front-end app. Multi-user sharing requires a backend.

## Contributing

Issues and PRs are welcome: bug fixes, docs, features. If you add content files, remember to update `content/manifest.json`.

## License

MIT. PDF rendering uses [Mozilla PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) via CDN.
