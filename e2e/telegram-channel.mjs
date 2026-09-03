import { runProbe } from './probe.mjs'

export async function runTelegramChannel({ root, test, assert, log }) {
  log('\n# telegram-channel')
  const result = await runProbe(root, 'bot/e2e-telegram-channel.mjs')

  await test('Telegram 识别 /new、/tasks 与 /mentions 命令', async () => {
    assert(result.commands.join(',') === 'new,new,tasks,mentions', `命令解析错误：${result.commands}`)
  })

  await test('Telegram 的 @ 名字转成 Web 同款结构化点名', async () => {
    assert(result.parsed.text === '查邮件并建立页面', `正文没有去掉 @ 前缀：${result.parsed.text}`)
    assert(result.parsed.mentions.map((m) => m.id).join(',') === 'gmail-personal,notion', `点名解析错误：${JSON.stringify(result.parsed)}`)
    assert(result.ambiguous.unknown === 'Gmail', '两把同名 Gmail 的简写应该被判为歧义')
    assert(result.help.includes('@Gmail_personal') && result.help.includes('@Gmail_work'), '帮助没有给出无歧义的 @ 名字')
  })

  await test('Telegram 任务清单使用 RichMessage 可渲染的 Markdown 任务项', async () => {
    assert(result.todos.includes('## 任务 · 1/3 已完成'), '任务进度标题不对')
    assert(result.todos.includes('- [x] 读取邮件'), '已完成任务没有勾选')
    assert(result.todos.includes('- [ ] ▶ 建立 \\*\\*页面\\*\\*'), '进行中任务或 Markdown 转义不对')
    assert(result.todos.includes('- [ ] ✗ ~~旧步骤~~'), '取消任务没有显示取消状态')
  })
}
