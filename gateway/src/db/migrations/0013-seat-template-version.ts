/**
 * 0013 · 席位自报「我这会儿跑的是模版第几版」。
 *
 * 模版保存即 +1，席位每分钟探一次指纹自己跟上（bot/src/catalog 的 poll）。可这条链路
 * 一直是**单向**的：Gateway 知道自己发到了 v5，不知道哪台席位真的换上了。管理员改完
 * 模版只能靠「等一分钟应该好了吧」，而真出事的时候——bot 进程死了、目录拉取一直失败、
 * 那台机器出不了网——界面上和一切正常长得一模一样。
 *
 * `tplVersion` 是**席位自己报的数**，不是 Gateway 期望它到的数；期望值在模版那一行上。
 * 两个数要分开存，合成一个「同步了没有」的布尔值就没法回答「差几版、卡在哪一版」。
 *
 * `tplSyncedAt` 记的是 **Gateway 收到那次汇报的时刻**，不是席位自报的时刻——席位机器
 * 的钟可能是歪的，而界面上那句「2 分钟前」必须准（同 0010 的 telemetryAt）。它还兼着
 * 一份心跳：版本对得上、但汇报停在两小时前，说明那个进程已经不在了。
 *
 * 两列都可空，且**没有默认值**：空 = 这台席位从来没报到过（老库里的行、刚部署完还没
 * 探过第一轮的），和「报到了、恰好是第 0 版」不是一回事。填 0 会让前者在界面上冒充
 * 后者。
 */
export const SQL = `
  alter table seat_runtimes add column if not exists "tplVersion" int;
  alter table seat_runtimes add column if not exists "tplSyncedAt" bigint;
`
