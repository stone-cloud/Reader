// 生成 PDF 测试 fixture（纯 Node，无第三方依赖）
// 用法：node tests/fixtures/generate-pdfs.mjs
// 产物：
//   with-outline.pdf  4 页，含三级书签（第 1 章 / 1.1 节 / 第 2 章 / 第 3 章）
//   no-outline.pdf    3 页，无书签（用于验证按每 20 页自动分章的降级策略）
// 说明：仅用于自动化/手动测试，请勿在产品代码中引用。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function pdfString(text) {
  return '(' + String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
}

function textStream(lines) {
  const parts = ['BT'];
  lines.forEach((line, index) => {
    const isTitle = index === 0;
    parts.push(`/F1 ${isTitle ? 24 : 12} Tf`);
    if (index === 0) parts.push('72 720 Td');
    else parts.push('0 -36 Td');
    parts.push(`${pdfString(line)} Tj`);
  });
  parts.push('ET');
  return parts.join('\n') + '\n';
}

/**
 * 生成一个最小但合法的 PDF 文件 Buffer。
 * pages: [{ lines: string[] }]
 * outline: null 或 [{ title, page, level, children: [] }]（page 为 1 基）
 */
function buildPdf({ pages, outline }) {
  const objects = []; // 1 基：objects[i-1] 是 obj i 的内容字符串
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };

  // 预留 1 Catalog / 2 Pages / 3 Font，其余按需分配
  const catalogNum = 1;
  const pagesNum = 2;
  const fontNum = 3;
  const firstPageNum = 4;
  const pageNums = pages.map((_, i) => firstPageNum + i);
  const firstContentNum = firstPageNum + pages.length;

  let outlineRootNum = null;
  const outlineItems = [];

  // Pages 树
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ');
  addObject(`<< /Type /Catalog /Pages ${pagesNum} 0 R${outline ? ` /Outlines ${pagesNum + 1 + 999} 0 R` : ''} /PageMode /UseNone >>`); // 占位，稍后替换
  addObject(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((page, i) => {
    const contentNum = firstContentNum + i;
    addObject(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
  });

  pages.forEach((page) => {
    const stream = textStream(page.lines);
    addObject(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  });

  if (outline && outline.length) {
    outlineRootNum = objects.length + 1;

    // 为所有书签条目分配对象号（深度优先，父在前），再计算同级链
    const entries = [];
    const assign = (nodes, parentNum) => {
      nodes.forEach((node) => {
        const num = objects.length + 1 + entries.length + 1;
        const entry = { node, num, parentNum, level: 0, children: [] };
        entries.push(entry);
        node.__entry = entry;
        if (node.children && node.children.length) assign(node.children, num);
      });
    };
    assign(outline, outlineRootNum);
    entries.forEach((entry) => {
      if (entry.node.children && entry.node.children.length) {
        entry.node.children.forEach((child) => { entry.children.push(child.__entry); });
      }
    });
    const rootChildren = outline.map((node) => node.__entry);

    const linkSiblings = (siblings) => {
      siblings.forEach((entry, idx) => {
        entry.siblingsNext = siblings[idx + 1] || null;
        entry.siblingsPrev = siblings[idx - 1] || null;
        if (entry.children && entry.children.length) linkSiblings(entry.children);
      });
    };
    linkSiblings(rootChildren);

    addObject(`<< /Type /Outlines /First ${rootChildren[0].num} 0 R /Last ${rootChildren[rootChildren.length - 1].num} 0 R /Count ${entries.length} >>`);

    entries.forEach((entry) => {
      const { node } = entry;
      const destPage = pageNums[Math.max(0, Math.min(pages.length - 1, (node.page || 1) - 1))];
      let body = `<< /Title ${pdfString(node.title)} /Parent ${entry.parentNum} 0 R /Dest [${destPage} 0 R /XYZ 0 792 0]`;
      if (entry.siblingsNext) body += ` /Next ${entry.siblingsNext.num} 0 R`;
      if (entry.siblingsPrev) body += ` /Prev ${entry.siblingsPrev.num} 0 R`;
      if (entry.children.length) {
        body += ` /First ${entry.children[0].num} 0 R /Last ${entry.children[entry.children.length - 1].num} 0 R /Count ${entry.children.length}`;
      }
      body += ' >>';
      addObject(body);
    });

    // 修正 Catalog 的 /Outlines 引用
    objects[catalogNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R /Outlines ${outlineRootNum} 0 R /PageMode /UseOutlines >>`;
  }

  // 组装文件并计算 xref
  const chunks = [];
  let offset = 0;
  const push = (text) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };
  push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = offset;
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = offset;
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i += 1) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

const chapterOutline = [
  {
    title: 'Chapter 1 Introduction',
    page: 1,
    children: [
      { title: 'Section 1.1 Background', page: 3, children: [] },
    ],
  },
  { title: 'Chapter 2 Details', page: 2, children: [] },
  { title: 'Chapter 3 Summary', page: 4, children: [] },
];

const withOutline = buildPdf({
  pages: [
    { lines: ['Chapter 1 Introduction', 'Welcome to the Reader PDF fixture.', 'This page belongs to chapter one.'] },
    { lines: ['Chapter 2 Details', 'The quick brown fox jumps over the lazy dog.', 'Chapter two covers the details.'] },
    { lines: ['Section 1.1 Background', 'A nested section starts on page three.', 'It is a child of chapter one.'] },
    { lines: ['Chapter 3 Summary', 'The final chapter summarizes everything.', 'End of the fixture.'] },
  ],
  outline: chapterOutline,
});

const noOutline = buildPdf({
  pages: [
    { lines: ['No Bookmark Fixture', 'This PDF has no outline entries.', 'The reader should split it by pages.'] },
    { lines: ['Page Two', 'Fallback chapter strategy applies here.', 'Each twenty pages form one chapter.'] },
    { lines: ['Page Three', 'The last page of the no-outline fixture.'] },
  ],
  outline: null,
});

writeFileSync(join(here, 'with-outline.pdf'), withOutline);
writeFileSync(join(here, 'no-outline.pdf'), noOutline);
console.log('generated:', join(here, 'with-outline.pdf'), withOutline.length, 'bytes');
console.log('generated:', join(here, 'no-outline.pdf'), noOutline.length, 'bytes');
