#!/usr/bin/env node
// Satuwork 的启动器。
//
// 内容跟 cordis 自带的 bin.js 是同一件事：建根 Context、挂 Loader、让它读
// cordis.yml。自己写一份是为了把包的选择写明白——我们用的是 DeepSeek vendor 的
// 那套框架包（@deepseek-ai/cordis 4.0.1），不是上游的 4.0.0-rc.8：上游主线还在
// RC，vendored 那份是 dsh 每天在跑的。
//
// package.json 里另有一条别名把 `cordis` 指到同一个物理包，因为上游的
// @cordisjs/plugin-server 是 `import { Service } from 'cordis'`。没有这条别名就会
// 加载两份框架，Service 和 Context 不是同一个类，服务注册不上去。
//
// 注意这里用的是**产品代码之外**的东西：框架本身。dsh 的产品包（dsh-agent、
// dsh-llm、dsh-tools…）一个都不用，那些我们自己写。

import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vendored from '@deepseek-ai/cordis'
import * as aliased from 'cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const { Context } = vendored

// 别名断线时要在这里响亮地失败。否则症状会是「server 服务找不到」——因为
// plugin-server 把自己注册到了另一份框架的 Context 上，排查起来完全指错方向。
if (aliased.Context !== vendored.Context) {
  throw new Error(
    'satuwork: `cordis` 与 `@deepseek-ai/cordis` 解析到了两份不同的框架。' +
      'package.json 里 "cordis": "npm:@deepseek-ai/cordis@…" 这条别名可能被破坏了。',
  )
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const ctx = new Context()
// 相对说明符（'./src/web/index.ts'）按这个基址解析，所以从任何工作目录启动都一样。
ctx.baseUrl = pathToFileURL(root).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
