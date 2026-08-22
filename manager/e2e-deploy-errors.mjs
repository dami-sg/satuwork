/**
 * 部署失败时那句话到底说了什么。**不走 HTTP**——要钉的是纯函数 tailError 的取舍。
 *
 * 由 e2e/deploy-errors.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 manager/ 而不是 e2e/：和别的探针同一个理由，裸导入按文件所在目录往上找。
 */
import { classifyHolder } from './src/reclaim.ts'
import { pruneRetired } from './src/seats.ts'
import { tailError } from './src/run.ts'

/**
 * 端口被占着时，管家决定「敢不敢清」的那一步（reclaim.ts 的 classifyHolder）。
 *
 * 现场：slot 0 的席位部署失败 `exited 43`，5910 上蹲着 sw-…-7bbe43f21941 的 x11vnc
 * ——一个已经拆掉、单元停了但进程从 logind session 里逃出来的席位。四种占口的东西
 * 处置完全不同，判错任何一种的代价都不对称，所以逐种钉住。
 */
const SPEC = { seatId: 'sw-me-0001', display: 10, vncPort: 5910, novncPort: 6081, botPort: 3200 }
/** 名册里活着的另一个席位，占的是 slot 5（bot 3205 / noVNC 6086 / rfb 5915）。 */
const LIVE = { seatId: 'sw-other-0002', linuxUser: 'sw-other', botPort: 3205, novncPort: 6086 }
const holder = (seatId, cmd = 'x11vnc -rfbport 5910') => ({ pid: '68056', seatId, cmd })
/** 端口那一路的问法。 */
const atPort = (port) => [`端口 ${port}（x11vnc）`, (row) => [row.botPort, row.novncPort, 5910 + (row.botPort - 3200)].includes(port)]
/** 显示号那一路——Xvfb 不占端口，判据换成 display = 10 + slot。 */
const atDisplay = (n) => [`显示 :${n}（Xvfb）`, (row) => 10 + (row.botPort - 3200) === n]

function verdicts() {
  return {
    ownStale: classifyHolder(SPEC, [], ...atPort(5910), holder('sw-me-0001')),
    orphan: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder('sw-gone-7bbe')),
    // 活席位现在的口被 Gateway 分给了我们：名册比 Gateway 旧了，以 Gateway 为准。
    staleRoster: classifyHolder({ ...SPEC, vncPort: 5915 }, [LIVE], ...atPort(5915), holder('sw-other-0002')),
    // 同一个活席位，但占的是它换槽位之前那一代的口——这个可以清，且只清这一个。
    staleGeneration: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder('sw-other-0002')),
    foreign: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder(null, 'x11vnc -rfbauth /home/slim/.vnc/passwd')),
    // 显示号走同一套判断：孤儿的 Xvfb 占着 :10，一个 TCP 口都不占。
    displayOrphan: classifyHolder(SPEC, [LIVE], ...atDisplay(10), holder('sw-gone-7bbe', 'Xvfb :10 -screen 0 1280x800x24')),
    // LIVE 在 slot 5（display :15），它的 Xvfb 蹲在 :10 就是上一代的残留。
    displayStaleGeneration: classifyHolder(SPEC, [LIVE], ...atDisplay(10), holder('sw-other-0002', 'Xvfb :10')),
  }
}

/** 回收停掉一个席位之后，名册要跟着销号——不销号，下一轮的判断依据就是假的。 */
function pruning() {
  const row = (seatId, botPort) => ({ seatId, linuxUser: 'sw-x', seatDir: `/home/sw-x/.satuwork/${seatId}`, botId: 'b', botVersion: '1', botPort, novncPort: botPort + 2881, deployedAt: 0, status: 'ready', lastError: null })
  const reg = { 'sw-me-0001': row('sw-me-0001', 3200), 'sw-old-0009': row('sw-old-0009', 3201) }
  const changed = pruneRetired(reg, ['sw-old-0009'])
  // 孤儿那一路：清掉的席位名册里本来就没有，一个字都没改，不该白写一次盘。
  const untouched = pruneRetired(reg, ['sw-never-seen'])
  return { pruneChanged: changed, pruneLeft: Object.keys(reg), pruneNoop: untouched }
}

const long = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join(' ')

const out = {
  // 失败的那条命令什么都没打印，前面全是正常进度——真实发生过的形状。
  silentFailure: tailError({ code: 3, stdout: '建用户 … chrome: 已在位', stderr: '' }, 'deploy script exited 3'),
  // 两个流都空：只剩退出码。
  bothEmpty: tailError({ code: 137, stdout: '', stderr: '' }, 'deploy script exited 137'),
  // stderr 有东西时也不能把 stdout 整个丢掉——「走到哪儿了」在 stdout 里。
  bothStreams: tailError({ code: 1, stdout: '进度A 进度B', stderr: '第 42 行失败' }, 'x'),
  // 超长输出留尾不留头：原因在最后。
  longTail: tailError({ code: 1, stdout: long('OUT', 400) + ' 最后一句', stderr: '' }, 'x'),
  code0: tailError({ code: 0, stdout: '', stderr: '' }, '兜底'),
  ...verdicts(),
  ...pruning(),
}
console.log('__RESULT__' + JSON.stringify(out))
