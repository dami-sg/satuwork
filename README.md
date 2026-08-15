# Satuwork

基于 [Cordis](https://github.com/cordiverse/cordis) 的 AI 员工平台。

## 跑起来

```bash
pnpm install
pnpm dev
```

打开 http://127.0.0.1:3082。

## 结构

```
cordis.yml        根组合：每行一个插件条目
src/web/          前端服务与 API 路由
ui/               前端
design/           设计稿（25 个视图）
docs/             事件模型与能力设计参考
```

## Cordis 的工作方式

插件是一个导出 `apply(ctx)` 的模块。`ctx` 是它注册一切的入口，注册项在插件卸载时
自动撤销——事件监听、服务、路由都不需要手工清理，非框架管理的资源用
`ctx.effect(() => disposer)` 包一层。

`inject` 声明硬依赖，Cordis 会把插件挂起在 PENDING 直到依赖就绪；依赖**在运行期
消失也会**触发卸载，回来再重新加载。所以 `apply` 里不需要写「服务还在吗」的防御
判断。可选依赖用 `ctx.get(name)` 探测。

服务是 `Service` 子类，`super(ctx, 'name')` 注册后其他插件通过 `ctx.name` 拿到；配
上 `declare module 'cordis'` 的接口合并就有完整类型。

事件有五种派发模式：`emit`（同步广播）、`parallel`（并发等待）、`serial`（顺序、
首个非空返回胜出）、`bail`（serial 的同步版）、`waterfall`（环绕中间件，可改写下游
结果或不调 `next()` 直接短路）。模式是事件契约的一部分。

`cordis.yml` 的条目**并发**挂载，行序不决定加载顺序——顺序来自 `inject`。
