import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import { fail, registerTool } from './common.ts'

/**
 * 看板工具集：`kanban_list` / `kanban_create` / `kanban_link` / `kanban_comment`。
 *
 * 一张板 = 这个员工名下的几颗 Bot 共用的一份待办清单。这几把是**板上的那一组**——主
 * 会话里就有，因为「帮我把这事拆成三张卡派给设计 Bot」发生在人和 Bot 的对话里。
 * 卡上的那一组（`kanban_show` / `kanban_complete` / `kanban_block`）只在卡片会话里有，
 * 那部分跟着执行面一起做。整套的理由见 docs/kanban.md。
 *
 * **没挂板的 Bot 一个字都不该看见**——工具描述是提示词，条件加载（同
 * docs/context-assembly.md §2）。但那一层不在这个文件里：判据是目录下发的 `boards`，
 * 而 `apply` 跑在第一次拉目录之前，所以这里无条件注册，遮掩做在 `toolSchemasFor` 里
 * （见下面 apply 开头那段）。
 */
export const name = 'satu-tools-kanban'
export const inject = ['tools', 'catalog']

/** 一次最多建几张。和 Gateway 那一侧同一个数，但**判据在那边**——这里只是先说清楚。 */
const CREATE_MAX = 5

function botId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}

/**
 * 打 Gateway。
 *
 * 连不上是**管道故障**（模型改什么都没用），HTTP 4xx 里那句话是**业务失败**——它是
 * Gateway 判出来的、能照着改的东西（不在这块板上、这颗 Bot 不是成员、一次太多张），
 * 原话直接给模型看。两者混成一种，模型要么白重试、要么把一次可修复的拒绝当成系统坏了。
 * 这一段和 tools/skill.ts 的 callGateway 是同一份，理由也一样。
 */
async function callGateway<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) fail('这台机器没有配 Gateway，看板这条路走不通。')
  let r: Response
  try {
    r = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let hint = ''
    try {
      hint = String((JSON.parse(text) as { error?: unknown })?.error ?? '')
    } catch {
      hint = ''
    }
    if (r.status >= 400 && r.status < 500) fail(hint || `Gateway 拒绝了这次操作（HTTP ${r.status}）`)
    throw new Error(`Gateway 返回 HTTP ${r.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  }
  return (await r.json()) as T
}

interface RemoteCard {
  id: string
  title: string
  state: string
  assigneeBotId: string | null
  summary: string
  blockedReason: string
  modelRole: string
}

interface RemoteBoard {
  id: string
  name: string
  brief: string
  myRole: string
  members: { botId: string; name: string; role: string }[]
  cards: RemoteCard[]
}

const STATE_LABEL: Record<string, string> = {
  todo: '等依赖',
  ready: '待派',
  running: '在跑',
  blocked: '卡住了',
  done: '做完了',
}

/** 一张卡在清单里的那一行。**带上 assignee 和状态**——模型下一步的决定全靠这两样。 */
function cardLine(c: RemoteCard): string {
  const who = c.assigneeBotId ? ` · ${c.assigneeBotId}` : ' · 没人认领'
  const tail = c.state === 'done' && c.summary ? `\n      结论：${c.summary.slice(0, 200)}` : ''
  const stuck = c.state === 'blocked' && c.blockedReason ? `\n      卡在：${c.blockedReason.slice(0, 200)}` : ''
  return `  [${STATE_LABEL[c.state] ?? c.state}] ${c.title}（${c.id}${who}）${tail}${stuck}`
}

export function apply(ctx: Context) {
  /**
   * **无条件注册，不在这儿判「在不在板上」。**
   *
   * `apply` 跑在第一次拉目录**之前**，那时 `boards` 必然是空的——照「不在板上就 return」
   * 写的话，这几把工具永远不会出现，而且是静默的。
   *
   * 「没挂板的 Bot 一个字都不该看见」那一层做在 `toolSchemasFor` 里（同 `browser_*`、
   * `memory_*`、`skill_manage` 那三处）：那是每一轮现算的，人刚把它加进板，下一轮就
   * 有了。而那一层**只是遮掩，不是强制**——模型硬报一个不在表里的名字照样调得通，真正
   * 的拒绝在 Gateway 那侧（不在任何板上时建卡回 400）。
   */
  const q = () => `?botId=${encodeURIComponent(botId())}`

  // ── kanban_list ──────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'kanban_list',
      /** 读，没有归属问题。子代理该看得见自己在做哪块板上的事。 */
      delegation: {},
      risk: ['read'],
      description:
        '看板：你在哪几块板上、板上有哪几颗 Bot 各干什么、现在有哪些卡。' +
        '**建卡之前先调它**——assignee 只能从这里列出的成员里挑，board 也从这里取。',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const out = await callGateway<{ boards: RemoteBoard[] }>('GET', `/runtime/kanban/boards${q()}`)
      if (!out.boards.length) return '你还没有被加进任何一块板。'
      return out.boards
        .map((b) => {
          const who = b.members
            .map((m) => `${m.name || m.botId}（${m.botId}${m.role ? ` · ${m.role}` : ''}）`)
            .join('、')
          const cards = b.cards.length ? b.cards.map(cardLine).join('\n') : '  （板上还没有卡）'
          return `## ${b.name}（${b.id}）\n${b.brief ? `${b.brief}\n` : ''}成员：${who}\n${cards}`
        })
        .join('\n\n')
    },
  )

  // ── kanban_create ────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'kanban_create',
      /**
       * **只有主代理有它。**
       *
       * 挡的是「子代理绕过深度限制去派活」：委派的深度定死 1，但子代理要是能建卡，它就
       * 能让另一台席位跑起来——正是那条限制要拦的东西，只是绕了一圈。
       */
      delegation: { mode: 'root-only' },
      /**
       * **不带 `external` 位**，理由和 delegate_task 那条一字不差：那一位判的是「打哪个
       * 外部系统」，而这里打的是我们自己的 Gateway；标上它，`no-external` 一开，这颗
       * Bot 一张卡都建不了。真正会出去的动作在做那张卡的 Bot 手上，到时候单独过闸。
       */
      risk: ['write'],
      description:
        '把一件事开成板上的卡，交给板上另一颗 Bot 去做。它跨得过这一轮：你收口之后它照跑，结论写回卡上。\n' +
        '**什么时候用**：要另一颗 Bot 的手艺（出图、审校）；几件事有先后要串起来；这件事这一轮做不完。\n' +
        '**什么时候别用**：你自己一轮里就能做完的 → 用 todo；要人拍板的 → escalate_to_human；' +
        '只是想要一份干净的上下文 → delegate_task。\n' +
        '**body 必须自足**：做卡的那颗 Bot 看不见这段对话，背景、已经试过什么、什么算做完，都写进去。\n' +
        '**assignee 只能从 kanban_list 列出的成员里挑**，board 也从那里取。\n' +
        '**先写 model_reason 再写 model_role**：先蹦出档位再补理由，写出来的是事后合理化。' +
        '两问都是「是」才给 utility——做法定死了吗？做错了看结论看得出来吗？' +
        '拿不准就别写 utility，没给理由的 utility 会被降成 daily。\n' +
        '要拿下游的结果，**建一张依赖卡指给你自己**，别指望它回头找你。',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: '往哪块板建。只在一块板上时可以不写。' },
          cards: {
            type: 'array',
            description: `一次最多 ${CREATE_MAX} 张。只有数组这一种形状，单张也写成一个元素。`,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '一句祈使句：要做成什么。不是话题，是完成判据。' },
                body: { type: 'string', description: '他需要知道的全部。他看不见这段对话。' },
                assignee: { type: 'string', description: '交给哪颗 Bot，写 kanban_list 里的 botId。' },
                parents: { type: 'array', items: { type: 'string' }, description: '要等哪几张卡做完，写卡号。同板。' },
                model_reason: { type: 'string', description: '**先写这个**：为什么配得上你选的那一档。一句话。' },
                model_role: { type: 'string', enum: ['daily', 'utility'], description: '机械活给 utility，判断活给 daily。' },
                needs_browser: { type: 'boolean', description: '这张卡要不要开浏览器。要的话会等席位那块屏空出来。' },
                max_steps: { type: 'number', description: '这张卡最多跑几步，默认 60。' },
              },
              required: ['title', 'assignee', 'model_reason', 'model_role'],
            },
          },
        },
        required: ['cards'],
      },
    },
    async ({ board, cards }: { board?: string; cards?: unknown[] }) => {
      if (!botId()) fail('这台席位没钉 Bot（缺 SATUWORK_BOT_ID），建不了卡。')
      if (!Array.isArray(cards) || !cards.length) fail('cards 是空的：要建哪几张？')
      if (cards.length > CREATE_MAX) fail(`一次最多 ${CREATE_MAX} 张，拆成两次。`)
      const out = await callGateway<{ cards: RemoteCard[]; merged: string[] }>('POST', `/runtime/kanban/cards${q()}`, {
        board: board ?? '',
        cards,
      })
      const lines = out.cards.map((c, i) => {
        // 合并进已有那张的要说清楚：不说的话模型会以为自己新建了一张，然后再建一次。
        const merged = out.merged.includes(c.id) ? '（和刚才那张是同一件事，合并了）' : ''
        return `${i + 1}. ${c.title} → ${c.assigneeBotId}${merged}\n   卡号 ${c.id} · ${STATE_LABEL[c.state] ?? c.state} · ${c.modelRole}`
      })
      return (
        `开好了 ${out.cards.length} 张：\n${lines.join('\n')}\n\n` +
        '它们会被排进去自己跑，你不用等。结论写在卡上，用 kanban_list 回头看。'
      )
    },
  )

  // ── kanban_link ──────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'kanban_link',
      /** 同 create：改依赖会让一张卡变成可派，等于间接派活。 */
      delegation: { mode: 'root-only' },
      risk: ['write'],
      description:
        '给两张卡之间加一条依赖：子卡要等父卡做完才会开始。两张卡必须在同一块板上，而且不能绕成圈。',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: '子卡的卡号：要等的那一张。' },
          parent: { type: 'string', description: '父卡的卡号：先做完的那一张。' },
        },
        required: ['card', 'parent'],
      },
    },
    async ({ card, parent }: { card?: string; parent?: string }) => {
      const child = (card ?? '').trim()
      const par = (parent ?? '').trim()
      if (!child || !par) fail('要写清楚哪张等哪张：card 是子卡，parent 是先做的那张。')
      await callGateway('POST', `/runtime/kanban/cards/${encodeURIComponent(child)}/links${q()}`, { parentId: par })
      return `记下了：${child} 要等 ${par} 做完。`
    },
  )

  // ── kanban_comment ───────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'kanban_comment',
      /** 留言没有归属问题，子代理也该说得上话。 */
      delegation: {},
      risk: ['write'],
      description:
        '往一张卡的时间线上留一句话。给接手那颗 Bot 的补充说明、或者你发现的坑，都写这儿——它开工时读得到，人也看得见。',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: '卡号。' },
          body: { type: 'string', description: '要说的话。' },
        },
        required: ['card', 'body'],
      },
    },
    async ({ card, body }: { card?: string; body?: string }) => {
      const id = (card ?? '').trim()
      const text = (body ?? '').trim()
      if (!id) fail('缺少 card：留言留在哪张卡上？')
      if (!text) fail('缺少 body：要说什么？')
      await callGateway('POST', `/runtime/kanban/cards/${encodeURIComponent(id)}/comments${q()}`, { body: text })
      return `写上了。${id} 的时间线上多了一条。`
    },
  )
}
