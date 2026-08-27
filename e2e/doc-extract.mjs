/**
 * PDF / Word / Excel 的文本提取。探针在 bot/e2e-extract.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一层的错**不报错**：转坏了照样返回一段文本，模型照着那段文本一本正经地答，人看不出
 * 数字是哪儿来的。所以每种格式最容易坏的那一处都单独钉一遍。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-extract.mjs')

export async function runDocExtract({ root, test, assert, log }) {
  log('\n# doc-extract')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.pdf && r.docx && r.xlsx, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('PDF 按页分，页序不乱', () => {
    assert(r.pdf.段数 === 2, `页数不对：${r.pdf.段数}`)
    assert(r.pdf.有第一页标记 && r.pdf.有第二页标记, '缺页码标记，模型没法说「第几页写着」')
    assert(r.pdf.第一页正文 && r.pdf.第二页正文, '有页丢了正文')
    assert(r.pdf.页序没颠倒, '页序颠倒了')
  })

  await test('扫描件 PDF：明说读不出来，不给一片空白', () => {
    // 空白结果会让模型以为文件坏了，反复重试同一个 read；说清楚它才会换别的办法。
    assert(r.blankPdf.明说了没有文字层, '没有文字层的 PDF 返回了空白，没有说明')
  })

  await test('Word：标题、加粗留着，表格**不能被拍平**', () => {
    assert(r.docx.标题, `标题没转成 markdown 标题：${r.docx.正文}`)
    assert(r.docx.加粗, '加粗丢了')
    // mammoth 自己的 convertToMarkdown 和 extractRawText 都会把表格拍成一列文本，
    // 行列关系全丢——业务文档里表格恰恰是最该留住的。所以这条单独钉死。
    assert(r.docx.表头行, `表头行没出来：${r.docx.正文}`)
    assert(r.docx.分隔行, `markdown 表格缺分隔行，渲染不出表：${r.docx.正文}`)
    assert(r.docx.数据行, `数据行没出来：${r.docx.正文}`)
  })

  await test('Word 里的图片不变成 base64', () => {
    // mammoth 默认把嵌入图片转成 data URI 塞进 HTML，一份带图的文档能撑出几 MB，
    // 而那些字节对模型一点用都没有。
    assert(r.docxImage.没有base64, '图片被转成 base64 灌进正文了')
    assert(r.docxImage.留了记号, '图片没留记号，读的人会以为文档断了一截')
  })

  await test('Excel：多表、CSV 转义、公式取结果、日期不是对象', () => {
    assert(r.xlsx.段数 === 2 && r.xlsx.两个表都在, `工作表没齐：${r.xlsx.正文}`)
    assert(r.xlsx.表头, '表头行不对')
    // 含逗号的单元格不加引号，这一行就多出一列，整张表跟着错位。
    assert(r.xlsx.逗号转义, `含逗号的单元格没转义：${r.xlsx.正文}`)
    assert(r.xlsx.引号转义, `含引号的单元格没转义：${r.xlsx.正文}`)
    // 公式给模型看 `=SUM(...)` 没有意义，要的是算出来的数。
    assert(r.xlsx.公式取结果, `公式没取缓存结果：${r.xlsx.正文}`)
    // exceljs 的日期是 Date、公式是对象、富文本是对象——不摊平会变成 [object Object]，
    // 那是**看起来有数据、其实全是垃圾**的坏法。
    assert(r.xlsx.日期不是对象, `日期没摊平：${r.xlsx.正文}`)
  })

  await test('稀疏工作表：行号会跳号，不能当成行数', () => {
    // eachRow 回调里的 n 是**工作表行号**。拿它去和上限比，一张数据从第 8000 行才
    // 开始的表第一行就「超限」，整表被丢空，输出成「0 行 + 已截断」——而模型会据此
    // 回答「这个表是空的」。
    assert(r.sparse.两行都在, `稀疏表的数据丢了：${r.sparse.正文}`)
    assert(r.sparse.行数对, `行数报错了：${r.sparse.正文}`)
    assert(r.sparse.没谎报截断, '只有两行却报了截断')
  })

  await test('太大的文件不解析，并且说清楚为什么', () => {
    // 这几个库都是整个文件读进内存再解析，exceljs 摊成对象图之后常是原文件的五到十倍。
    // 上传上限默认 100 MiB，不设这道闸，传个大 xlsx 再 read 一下就能把席位进程撑爆。
    assert(r.huge.没去解析, '超大文件仍然被解析了')
    assert(r.huge.说了多大 && r.huge.指了条别的路, `拒绝得不清不楚：${JSON.stringify(r.huge)}`)
  })

  await test('只认这套库真能读的后缀', () => {
    assert(r.kinds.pdf === 'pdf' && r.kinds.docx === 'docx' && r.kinds.xlsm === 'xlsx', '该认的没认出来')
    assert(r.kinds.xlsx === 'xlsx', '大写后缀没认出来')
    // .doc / .xls 是另一套老二进制格式，这几个库读不了。认了只会给一堆乱码，
    // 而乱码比「不能按文本读」更难排查。
    assert(r.kinds.doc === null && r.kinds.xls === null, '.doc / .xls 不该被当成能读的')
    assert(r.kinds.txt === null, '.txt 该走普通读法，不该绕一趟提取')
  })

  await test('同一个文件读第二次走缓存', () => {
    // 模型翻一份长 PDF 会连着调好几次 read，每次重解析一遍整个文件既慢又白烧 CPU。
    // 断言比的是冷读和热读的**倍数**，不是绝对毫秒——绝对阈值在 CI 上会随机红。
    assert(
      r.cache.明显更快,
      `冷读 ${r.cache.冷读毫秒} ms、第二次 ${r.cache.第二次毫秒} ms，没看出缓存`,
    )
  })
}
