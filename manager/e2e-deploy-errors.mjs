/**
 * 部署失败时那句话到底说了什么。**不走 HTTP**——要钉的是纯函数 tailError 的取舍。
 *
 * 由 e2e/deploy-errors.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 manager/ 而不是 e2e/：和别的探针同一个理由，裸导入按文件所在目录往上找。
 */
import { tailError } from './src/run.ts'

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
}
console.log('__RESULT__' + JSON.stringify(out))
