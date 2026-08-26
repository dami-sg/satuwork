/**
 * 日常任务用哪个模型跑：平台的**日常模型**，还是**utility 模型**。
 *
 * 定时任务是「一天一次、没人在等」的活，而它跑的却是这个 Bot 平时聊天用的那个模型
 * ——最贵的那一档。给它一个开关，默认落在 utility 上：省下来的是每天、每条任务、
 * 每个人的一份 token。
 *
 * **已有的那几条也一并落到 utility**（`add column ... default` 就是这么填的）。
 * 这是明知的取舍：它们是在只有一种模型可用的时候建的，人当时没得选，所以那个值
 * 不代表「他选了日常模型」。要更聪明的那一档，界面上拨回去就是——而反过来（默认
 * 留在贵的那一档）意味着这次改动对存量一个 token 都省不下来。
 */
export const SQL = `
  alter table routines add column if not exists "modelRole" text not null default 'utility';
`
