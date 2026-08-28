/**
 * 0019 · 席位部署走到哪一步了、从什么时候开始的。
 *
 * `status` 只有 `deploying` 这一个字来描述整段安装，而这段在一台干净机器上要跑十几
 * 分钟（apt 装一整套桌面栈、拉发布包、装浏览器、起单元）。人建完 Bot 就坐在那一屏
 * 上等，界面上却只有一句「部署中…」——它在第一秒和第十分钟长得一模一样，于是唯一
 * 的判断依据变成「等这么久了是不是卡死了」，而正确答案通常是「没有，正常就这么久」。
 *
 * `deployPhase` 是 **Gateway 自己知道的那两档**：`queued`（席位登记好了，还没发出去）
 * 和 `installing`（已经交给机器管家，机器上在装）。机器里面那几步（装桌面、装浏览
 * 器、起 bot）Gateway 看不见，那份更细的进度由管家现问现答（见 manager 的
 * `/seats/:id/progress`），**不落库**——它每几秒变一次，写进来只会把这张表变成一张
 * 高频写的表，而它过期之后一文不值。
 *
 * `deployStartedAt` 是这一次部署开始的时刻，`updatedAt` 顶不了它：那一列每写一次行
 * 都会动，算不出「已经装了多久」。**是这一次**，所以每次重铺都重写；`deployedAt` 记
 * 的是上一次成功装完的时刻，两件事。
 *
 * 两列都可空：老行没有，装完之后也清空——它们只在「正在装」这段时间里有意义。
 */
export const SQL = `
  alter table seat_runtimes add column if not exists "deployPhase" text;
  alter table seat_runtimes add column if not exists "deployStartedAt" bigint;
`
