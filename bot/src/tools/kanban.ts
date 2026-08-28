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
export const inject = ['tools', 'catalog', 'agents']

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

/**
 * 席位的**运行面**向 Gateway 回报一张卡的收口。
 *
 * 走 `/internal`，不走 `/runtime`——**判据是「谁在说话」**：这一条是这台机器在汇报
 * （和「这条会话结束了」「这次用了多少 token」同一类），不是模型在说话。混进模型那一组
 * 的话，模型有一天就能自己报一句「这张卡跑完了」。
 *
 * 这里用的是席位票（`sat_`），Gateway 那边 `requireInternalCaller` 认它，并且只允许它
 * 替**自己那个账号**说话。
 */
export async function reportCard(cardId: string, body: Record<string, unknown>): Promise<void> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) return
  const r = await fetch(`${base}/internal/kanban/cards/${encodeURIComponent(cardId)}/result`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  // 409 = 那边已经收过口了（比如 kanban_complete 报过一次，收尾这条又报了一次）。
  // **不是错**：正是我们要的那个「只收一次」。
  if (!r.ok && r.status !== 409) {
    throw new Error(`回报卡 ${cardId} 失败：HTTP ${r.status}`)
  }
}

/**
 * 心跳：席位每 60 秒替正在跑的卡报一次「还活着」。
 *
 * **模型不管这件事**（所以没有 `kanban_heartbeat` 这把工具）：让模型负责保活，是把一个
 * 运维问题伪装成一个提示词问题——它会忘，而忘了的表现是一张明明在跑的卡被判成崩了。
 *
 * 返回 false = Gateway 那边说这张卡已经不在了（人撤了、板删了、或者被判失联收掉了），
 * 席位据此掐掉那一轮，而不是继续跑一个没人认领的活。
 */
export async function beatCard(cardId: string): Promise<boolean> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) return true
  try {
    const r = await fetch(`${base}/internal/kanban/cards/${encodeURIComponent(cardId)}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    // 连不上不当作「卡没了」：网络抖一下就掐掉一轮正在跑的活，代价比多跑一会儿大得多。
    return r.ok || r.status >= 500
  } catch {
    return true
  }
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

  // ── 卡上的那一组：只有卡片会话里调得通 ────────────────────────────────
  //
  // 「当前这张卡」只存在于卡片会话里，主会话里没有这个东西。判据挂在**工具自己**身上
  // （`ctx.agents.cardOf(call.sessionId)`），不是靠「主会话的 schema 里没有它」——那只是
  // 遮掩，模型硬报一个名字照样调得通。

  /** 这次调用是在哪张卡上。不在卡片会话里就当场说清楚，别让它以为是自己参数写错了。 */
  const cardOf = (sessionId: string) => {
    const row = ctx.agents.cardOf?.(sessionId)
    if (!row) fail('这里不是卡片会话——`kanban_show` / `kanban_complete` / `kanban_block` 只在你正做着某张卡的时候才有意义。')
    return row!
  }

  registerTool(
    ctx,
    {
      name: 'kanban_show',
      /** 读。卡片会话里派出去的子代理**该**看得见自己在做哪张卡。 */
      delegation: {},
      risk: ['read'],
      description: '把你正在做的这张卡再读一遍：正文、上游卡的结论、卡上的留言。开工的交底书已经在第一条消息里了，这把是给「做到一半想再核对一下」用的。',
      parameters: { type: 'object', properties: {} },
    },
    async (_args: unknown, call) => {
      const row = cardOf(call.sessionId)
      const out = await callGateway<{ card: RemoteCard & { body: string }; parents: RemoteCard[]; timeline: { authorBotId: string | null; body: string }[] }>(
        'GET',
        `/runtime/kanban/cards/${encodeURIComponent(row.cardId)}${q()}`,
      )
      const parents = out.parents.length
        ? `\n\n## 上游卡的结论\n${out.parents.map((p) => `### ${p.title}（${p.id}）\n${p.summary || '（它没留下结论）'}`).join('\n\n')}`
        : ''
      const said = out.timeline.filter((t) => t.body.trim())
      const notes = said.length ? `\n\n## 留言\n${said.map((t) => `- ${t.authorBotId ?? '人'}：${t.body}`).join('\n')}` : ''
      return `# ${out.card.title}（${out.card.id}）\n\n${out.card.body || '（这张卡没写正文）'}${parents}${notes}`
    },
  )

  registerTool(
    ctx,
    {
      name: 'kanban_complete',
      /**
       * **只有这一层有。**
       *
       * 收口是这张卡那一轮的事：子代理替它收口的话，主流程还在跑，而卡已经 done 了——
       * 而且那段结论是子代理写的，不是真正做完这件事的那一位写的。
       */
      delegation: { mode: 'root-only' },
      risk: ['write'],
      description:
        '这张卡做完了。**结论要自足**：做了什么、结果是什么、还有什么没做——下游那张卡看不见你的过程，只看得见这一段。\n' +
        '产出的文件路径写进 metadata.changed_files，下游靠它找东西，不是靠猜目录。\n' +
        '做不完就别调它，调 kanban_block。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '结论。一段话，自足。' },
          metadata: {
            type: 'object',
            description: '交付证据：changed_files（产出路径）、verification（怎么验的）、residual_risk（哪些没验）。',
            properties: {
              changed_files: { type: 'array', items: { type: 'string' } },
              verification: { type: 'array', items: { type: 'string' } },
              residual_risk: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['summary'],
      },
    },
    async ({ summary, metadata }: { summary?: string; metadata?: Record<string, unknown> }, call) => {
      const row = cardOf(call.sessionId)
      const text = (summary ?? '').trim()
      if (!text) fail('缺少 summary：这张卡做成什么样了？下游那张卡只看得见这一段。')
      // **一调就报，不等 turn/end**：你之后还可能接着说两句、还可能撞上步数上限被截断，
      // 而那时收口已经发生了。等到 turn/end 一起报的话，「跑完了没交结论」那条判据永远
      // 为真，每张卡都会被算成一次失败。
      if (!ctx.agents.markCardSettled?.(call.sessionId)) fail('这张卡已经收过口了，别再报一次——两段不一样的结论，后写的那段未必是对的那段。')
      await reportCard(row.cardId, { status: 'ok', summary: text, metadata: metadata ?? null, sessionId: call.sessionId })
      return `收到，${row.cardId} 记成做完了。接下来把手上的事收个尾就行，不用再做新的。`
    },
  )

  registerTool(
    ctx,
    {
      name: 'kanban_block',
      delegation: { mode: 'root-only' },
      risk: ['write'],
      description:
        '这张卡干不下去了，要人。把**卡在哪儿、已经排除了什么**写清楚，然后停下来。\n' +
        '要人拍板、缺一个只有人知道的东西、权限不够，都走这条。**不要换个写法再试三遍**——你面前没有人，试到最后也没人会回答你。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '卡在哪儿，一句话说清。顺带写上你已经排除了什么。' } },
        required: ['reason'],
      },
    },
    async ({ reason }: { reason?: string }, call) => {
      const row = cardOf(call.sessionId)
      const text = (reason ?? '').trim()
      if (!text) fail('缺少 reason：卡在哪儿？不写的话人打开这张卡第一件事是回来问你。')
      if (!ctx.agents.markCardSettled?.(call.sessionId)) fail('这张卡已经收过口了。')
      await reportCard(row.cardId, { status: 'blocked', error: text, sessionId: call.sessionId })
      return `记下了，${row.cardId} 转给人处理。停下来吧，别再试了。`
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
