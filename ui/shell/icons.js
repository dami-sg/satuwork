import { h } from 'preact'

/**
 * 图标。
 *
 * 全部取自设计稿：同一套线宽（2.75）、同一个 24 网格。图标散在各屏里各画各的，
 * 一眼就能看出接缝——所以只在这里画。
 */

export function icon(paths, size = 17) {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    paths.map((d, i) => h(d.startsWith('R') ? 'rect' : 'path', { key: i, d })),
  )
}

/** AI 员工的头像图标。key 对不上时落到标准机器人，不留空。 */
export const AGENT_ICONS = {
  bot: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 5v4', 'M12 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M8.5 14h.01', 'M15.5 14h.01', 'M9.5 17.5h5'],
  chat: ['M4 8h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-3l-5 4v-4H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 4v4', 'M8.5 12h.01', 'M15.5 12h.01'],
  chart: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'M8 17v-3', 'M12 17v-5', 'M16 17v-2'],
  pen: ['M5 9h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M9.5 4v5', 'M7 14h.01', 'M11 14h.01', 'M22 3l-5.5 5.5', 'M19 3h3v3'],
  deal: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'M8 16l2.5-2.5L13 16l3-3.5', 'M8.5 13h.01'],
  code: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'm9.5 13-1.5 1.5 1.5 1.5', 'm14.5 13 1.5 1.5-1.5 1.5'],
}

export function agentIcon(key, size = 17) {
  return icon(AGENT_ICONS[key] ?? AGENT_ICONS.bot, size)
}

/**
 * 分组图标。稿子上新建分组时从这一排里挑一个，列表那一列画的也是它。
 *
 * key **是存进库的**，图形可以改，key 不能——改一个 key，所有选过它的分组会
 * 一起掉回默认图标。
 *
 * 挑图形的标准只有一条：在 17px 上一眼认得出，且**八个互不相像**。稿子里那版有
 * 三个不合格，见下面各自的注释。带 name 是因为这排按钮只有图形没有字，读屏与
 * 悬浮提示都要靠它。
 */
export const GROUP_ICONS = [
  { key: 'chat', name: '对话', paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  { key: 'chart', name: '数据', paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M8 17v-4', 'M13 17v-9', 'M18 17v-6'] },
  // 稿子这个只有两段身子没有头，画出来是两道弧。补上头。
  {
    key: 'users',
    name: '团队',
    paths: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  },
  // 稿子这个是「加成员」，和导航上的账号管理是同一个图形，读不出「外部」。换成
  // 地球：这一排里唯一的圆，和「团队」那个人形也不会互相认错。
  { key: 'guest', name: '外部', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z'] },
  { key: 'code', name: '研发', paths: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13 6-2 12'] },
  // 稿子这个是条上扬的折线，和上面的「数据」在 17px 上分不开。换成价签。
  { key: 'deal', name: '销售', paths: ['M3 3h8l10 10-8 8L3 11z', 'M7 7h.01'] },
  { key: 'shield', name: '权限', paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'] },
  { key: 'star', name: '重点', paths: ['m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z'] },
]

/** key 对不上时落到「对话」，不留空。 */
export function groupIcon(key, size = 17) {
  return icon((GROUP_ICONS.find((g) => g.key === key) ?? GROUP_ICONS[0]).paths, size)
}

/**
 * 执行模式。这是**界面词汇**，不是强制点——真正的拦截在宿主的 `tools/pre-execute`
 * 上。放这里是因为它同时出现在新建对话与新建定时任务两处，两边必须一字不差。
 */
export const EXEC_MODES = [
  {
    key: 'read',
    label: 'Read only',
    hint: '只读：可检索知识库与数据库，不写入、不调用外部工具。',
    paths: ['M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4', 'M12 15v3'],
  },
  {
    key: 'ask',
    label: 'Ask for approval',
    hint: '每次写入、发送或调用外部工具前，先向你确认。',
    paths: ['m9 11 3 3 8-8', 'M21 12a9 9 0 1 1-5.6-8.3'],
  },
  {
    key: 'full',
    label: 'Full access',
    hint: '完全授权：可直接写入数据、发送邮件与调用已授权的 MCP。',
    paths: ['M13 2 3 14h7l-1 8 10-12h-7z'],
  },
]

/** 各屏都在用的那几个。 */
export const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  bubble: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  schedule: ['m3 7 2 2 4-4', 'm3 17 2 2 4-4', 'M13 7h8', 'M13 17h8'],
  clip: ['M13.2 6.3 6.3 13.2a3 3 0 0 0 4.2 4.2l6.9-6.9a5 5 0 0 0-7-7L3.9 10a7 7 0 0 0 9.9 9.9'],
  book: ['M12 7v14', 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'],
  db: ['M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0', 'M12 2a9 3 0 0 0 0 6 9 3 0 0 0 0-6z'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  arrowLeft: ['M19 12H5', 'm12 19-7-7 7-7'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  dots: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
}
