/**
 * PDF / Word / Excel 的文本提取。探针要 tsx 才 import 得了 .ts。
 *
 * 样本全是**现场造的**，不放 checked-in 的二进制：二进制样本没人看得懂，改一个字段
 * 就得整个重新生成，而且 review 时只能看见「一坨变了」。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { docKindOf, extractDocument } from './src/workspace/extract.ts'

const dir = mkdtempSync(join(tmpdir(), 'satu-doc-'))
const out = {}

// ── 造一个最小的、带真文字层的 PDF ───────────────────────────────────
function buildPdf(pages) {
  const objs = []
  const streams = pages.map((t) => `BT /F1 14 Tf 40 700 Td (${t}) Tj ET`)
  const n = pages.length
  const pageIds = pages.map((_, i) => 3 + i)
  const contentIds = pages.map((_, i) => 3 + n + i)
  const fontId = 3 + 2 * n
  objs[1] = `<</Type/Catalog/Pages 2 0 R>>`
  objs[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${n}>>`
  pageIds.forEach((id, i) => {
    objs[id] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentIds[i]} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`
  })
  contentIds.forEach((id, i) => {
    objs[id] = `<</Length ${streams[i].length}>>\nstream\n${streams[i]}\nendstream`
  })
  objs[fontId] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`
  let s = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i++) {
    if (!objs[i]) continue
    offsets[i] = s.length
    s += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = s.length
  const count = objs.length
  s += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let i = 1; i < count; i++) {
    s += objs[i] ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : `0000000000 65535 f \n`
  }
  s += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(s, 'latin1')
}

/** 一份只有正文、没有文字层的 PDF——模拟扫描件。 */
function buildBlankPdf() {
  return buildPdf([''])
}

// ── 造 docx ───────────────────────────────────────────────────────────
async function buildDocx(bodyXml, extra) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip
    .folder('_rels')
    .file(
      '.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
  const w = zip.folder('word')
  w.file(
    'document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
      bodyXml +
      '</w:body></w:document>',
  )
  if (extra) await extra(w)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const p = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text) => `<w:tc>${p(text)}</w:tc>`

// ── 1. PDF：按页分，页码标记在 ────────────────────────────────────────
const pdfPath = join(dir, 'two.pdf')
writeFileSync(pdfPath, buildPdf(['First page says apple.', 'Second page says banana.']))
const pdf = await extractDocument(pdfPath, 'pdf')
out.pdf = {
  段数: pdf.parts,
  单位: pdf.unit,
  有第一页标记: pdf.text.includes('第 1 页 / 共 2 页'),
  有第二页标记: pdf.text.includes('第 2 页 / 共 2 页'),
  第一页正文: pdf.text.includes('apple'),
  第二页正文: pdf.text.includes('banana'),
  页序没颠倒: pdf.text.indexOf('apple') < pdf.text.indexOf('banana'),
}

// ── 2. 扫描件：说清楚读不出来，而不是给一片空白 ──────────────────────
const blankPath = join(dir, 'scan.pdf')
writeFileSync(blankPath, buildBlankPdf())
const blank = await extractDocument(blankPath, 'pdf')
out.blankPdf = { 明说了没有文字层: blank.text.includes('没有文字层') }

// ── 3. DOCX：标题、加粗、表格、图片 ──────────────────────────────────
const docxPath = join(dir, 'a.docx')
writeFileSync(
  docxPath,
  await buildDocx(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度小结</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>收入增长 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>12%</w:t></w:r><w:r><w:t>。</w:t></w:r></w:p>' +
      `<w:tbl><w:tr>${cell('区域')}${cell('销量')}</w:tr><w:tr>${cell('华东')}${cell('320')}</w:tr></w:tbl>`,
  ),
)
const docx = await extractDocument(docxPath, 'docx')
out.docx = {
  标题: docx.text.includes('# 季度小结'),
  加粗: docx.text.includes('**12%**'),
  // 这是重点：mammoth 自己的 markdown 输出会把表格拍平，行列关系全丢。
  表头行: docx.text.includes('| 区域 | 销量 |'),
  分隔行: docx.text.includes('| --- | --- |'),
  数据行: docx.text.includes('| 华东 | 320 |'),
  正文: docx.text,
}

// ── 4. DOCX 里的图片不能变成 base64 灌进来 ───────────────────────────
const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)
const imgPath = join(dir, 'img.docx')
writeFileSync(
  imgPath,
  await buildDocx(
    '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData>' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>' +
      '<a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    async (w) => {
      w.folder('_rels').file(
        'document.xml.rels',
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/x.png"/></Relationships>',
      )
      w.folder('media').file('x.png', png)
    },
  ),
)
const withImg = await extractDocument(imgPath, 'docx')
out.docxImage = { 没有base64: !withImg.text.includes('base64'), 留了记号: withImg.text.includes('[图片]') }

// ── 5. XLSX：多表、公式、日期、要转义的单元格 ────────────────────────
const xlsxPath = join(dir, 'b.xlsx')
{
  const wb = new ExcelJS.Workbook()
  const s1 = wb.addWorksheet('销量')
  s1.addRow(['区域', '数量', '备注'])
  s1.addRow(['华东', 320, '含税, 已对账'])
  s1.addRow(['华南', 180, '带"引号"'])
  const s2 = wb.addWorksheet('汇总')
  s2.addRow(['合计'])
  s2.addRow([{ formula: 'SUM(销量!B2:B3)', result: 500 }])
  s2.addRow([new Date(Date.UTC(2026, 0, 15))])
  await wb.xlsx.writeFile(xlsxPath)
}
const xlsx = await extractDocument(xlsxPath, 'xlsx')
out.xlsx = {
  段数: xlsx.parts,
  两个表都在: xlsx.text.includes('工作表：销量') && xlsx.text.includes('工作表：汇总'),
  表头: xlsx.text.includes('区域,数量,备注'),
  // 含逗号的单元格不加引号的话，这一行会多出一列，整张表跟着错位。
  // 用 ASCII 逗号才真的触发转义——中文逗号是另一个字符，不会让列错位。
  逗号转义: xlsx.text.includes('"含税, 已对账"'),
  引号转义: xlsx.text.includes('""引号""'),
  // 公式要给算出来的数，不是 =SUM(...)。
  公式取结果: xlsx.text.includes('500') && !xlsx.text.includes('SUM('),
  日期不是对象: !xlsx.text.includes('[object') && xlsx.text.includes('2026-01-15'),
  正文: xlsx.text,
}

// ── 6. 认哪些后缀 ─────────────────────────────────────────────────────
out.kinds = {
  pdf: docKindOf('a.pdf'),
  docx: docKindOf('a.docx'),
  xlsx: docKindOf('a.XLSX'),
  xlsm: docKindOf('a.xlsm'),
  // 老二进制格式这套库读不了，不能认——认了只会给出一堆乱码。
  doc: docKindOf('a.doc'),
  xls: docKindOf('a.xls'),
  txt: docKindOf('a.txt'),
}

// ── 7. 缓存：同一个文件读两次不重新解析 ──────────────────────────────
const t0 = process.hrtime.bigint()
await extractDocument(pdfPath, 'pdf')
const warm = Number(process.hrtime.bigint() - t0) / 1e6
out.cache = { 第二次毫秒: warm, 明显更快: warm < 5 }

console.log('__RESULT__' + JSON.stringify(out))
