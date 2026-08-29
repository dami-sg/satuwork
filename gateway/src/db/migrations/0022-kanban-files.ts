/**
 * 卡的附件清单（见 docs/kanban.md）。字节落盘在 $SATUWORK_GATEWAY_HOME/kanban/<cardId>/，
 * 这里只登记元数据——和发布包同一个口径（bot_releases 只存元数据，tarball 在 releases/）。
 *
 * **为什么要过 Gateway 的手**：开卡的那一刻席位可能根本没开机，文件先存在板上，派卡
 * 那一下随执行包一起下去，席位把它们写进那棵共享的 `~/work`——Bot 拿到的路径和聊天里
 * 上传的文件是同一棵树，工具一个不用改。
 */
export const SQL = `
  create table if not exists card_files (
    id          text primary key,
    "cardId"    text not null references cards(id) on delete cascade,
    -- 落盘时洗过一遍的名字；界面上显示它，席位收到的也是它。
    name        text not null,
    size        integer not null,
    -- 相对 $SATUWORK_GATEWAY_HOME 的路径（kanban/<cardId>/<id>-<name>）。
    path        text not null,
    "createdAt" bigint not null
  );
  create index if not exists card_files_of_card on card_files ("cardId");
`
