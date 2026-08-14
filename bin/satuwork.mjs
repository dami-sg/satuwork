#!/usr/bin/env node
// Satuwork 的启动入口。
//
// 这里是**我们自己的 Cordis 根**：cordis.yml 由我们拥有，dsh 的包只是被逐行挂进来的
// 依赖。不是「装一个 dsh 再往上打补丁」——那样 dsh 决定组合、我们只能覆盖；现在组合
// 是我们的，要哪一行、不要哪一行、换成谁，都在 cordis.yml 里直说。
//
// dsh-app-boot 只是启动胶水（创建根 context、装 Loader、挂 include 树、断言全部
// 加载与激活、失败响亮退出），不带任何产品决策。

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadEnv,
  renderConfigDump,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const BIN = 'satuwork'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const configPath = join(root, 'cordis.yml')

installFailLoud(BIN)
loadEnv(BIN, root)

if (process.argv.includes('--dump-config')) {
  console.log(renderConfigDump(BIN, configPath, []))
  process.exit(0)
}

// 命令行与退出请求是**启动器的事实**，不是配置：树里的 web-startup 注入
// cmdlineArgs 来解析自己的 --port/--host，所以必须在任何 entry 挂载之前提供，
// 也就是 boot 的 prepare 钩子里。少了这一步，整棵 web 表面都会停在 pending。
const prepare = (ctx) => {
  provideCmdline(ctx, {
    args: process.argv.slice(2),
    exit: (code = 0) => process.exit(code),
  })
}

// 裸包名锚定到本项目的 node_modules，而不是 cordis.yml 所在目录的解析结果——
// 两者现在同一个目录，但显式给出后，配置文件将来移动位置也不会解析错。
await boot(BIN, configPath, undefined, prepare, new URL('../', import.meta.url).href)
