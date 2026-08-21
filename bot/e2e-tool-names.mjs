/**
 * `mcpToolName` 的探针。e2e/tool-names.mjs 用。
 *
 * 单独起一个进程只为一件事：那个函数在 .ts 里，而 e2e/run.mjs 是裸 node 跑的，
 * import 不动 .ts。argv 收一组 [服务器名, 工具名]，回一组合成出来的工具名。
 */
import { mcpToolName } from './src/catalog/mcp.ts'

const pairs = JSON.parse(process.argv[2] || '[]')
console.log(`__RESULT__${JSON.stringify(pairs.map(([s, t]) => mcpToolName(s, t)))}`)
