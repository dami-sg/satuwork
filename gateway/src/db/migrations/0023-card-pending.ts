/**
 * 卡的状态枚举加「待定」（pending）：人开卡先落在这里，等人拖进「待派」才被调度。
 *
 * **Postgres 的 check 约束没有名字就用默认名**（cards_state_check）——0021 里那句
 * `state text not null check (state in (…))` 落下来就是这个名字，这里按名拆掉重挂。
 */
export const SQL = `
  alter table cards drop constraint cards_state_check;
  alter table cards add constraint cards_state_check check (state in ('pending','todo','ready','running','blocked','done','archived','cancelled'));
`
