# satuwork-harness

Satuwork 自己的插件包。现在装着两样东西：一个宿主锚点，和覆盖 dsh 界面令牌的主题。

它**不是 dsh 的 bundle**——我们不走 profile/bundle 那条路，组合权在项目根的 [`cordis.yml`](../cordis.yml) 手里。这个包只是被那棵树挂进来的一行。

```
harness/
├── host.js               宿主侧插件（锚点，见下）
├── build.mjs             把 theme.css 内联成客户端 bundle
├── src/client/theme.css  --dsw-alias-* 覆盖表，值来自 design/theme.css
└── dist/client.js        构建产物（gitignore）
```

```bash
node harness/build.mjs        # 或 pnpm build
```

## 为什么需要一个「什么都不做」的宿主插件

`client-modules` 服务扫描的是**宿主 Loader 的 entries** 里声明了 `dsh.client` 的包，据此决定往浏览器启动图（`window.__DSH_BOOT__`）里放哪些客户端 bundle。只贡献配置、不占一行的包不是 entry，扫不到，客户端主题也就永远不会加载。

`host.js` 就是这一行。以后 Satuwork 的宿主侧插件（`satu-kb`、`satu-scheduler`…）会各自成行，这个锚点届时可以退场。

## 主题

[`src/client/theme.css`](src/client/theme.css) 把 dsh 的 `--dsw-alias-*` 语义令牌覆盖成 [design/theme.css](../design/theme.css) 的值。

这条路是官方认的：ui-theme 的 README 写着第三方主题「就是覆盖同名 alias 变量」。dsh 的样式纪律是功能组件只读 `--dsw-alias-*`、不写字面色值，所以换肤不用碰任何功能组件。

实测生效：`brand-primary` 读到 `#c96442`、`bg-base` 读到 `#faf9f5`、字体栈以 Outfit 打头。

### 客户端 bundle 的格式（两个坑，都不是文档里能看出来的）

产物**不是 ESM**，是客户端模块表要求的 lazy-CJS：

```js
window.__ModuleLoader__.load({ id: 'satuwork-harness', factory: (require) => { … } })
```

脚本执行时只注册工厂；模块体的副作用（**包括注入 CSS**，源码注释里明写这是预期用法）在首次 materialize 时才跑。发普通 ESM 会得到 `loaded without registering "…" via __ModuleLoader__.load`，整页启动失败。

另一个更隐蔽：扫描用 `require.resolve('<pkg>/package.json')`，而包一旦声明 `exports`，Node 的 exports 闸门就挡掉 `./package.json`，包被判为「不是客户端包」**静默跳过**，没有任何报错。`exports` 里必须显式写 `"./package.json": "./package.json"`。

改完 CSS 要**重启服务**：bundle 按内容哈希的 `rev` 缓存，只有 `rebuilt()` 会更新它。

### 令牌覆盖不到的地方

实测：**151 个客户端 UI 包里 16 个含字面色值，约 35 处**（同包多路径有重复，去重后更少）。令牌纪律在九成以上的界面成立，剩下的是明确的例外——ui-theme 的 README 自己承认了（"values absent from cssdesign… are deliberately not appended"）。

已确认的一处：**输入框的发送按钮硬编码 `rgb(65, 118, 230)`**，即使对应令牌已覆盖成赭红也不跟着变。这类要逐个用组件级 CSS 规则盖，靠令牌盖不住。

### 还改不动的

- **圆角**：令牌表里没有 radius 变量，各组件写在自己的 CSS Modules 里。设计稿的 `--radius: 1rem` 覆盖不到
- **字体**：`--dsw-font-family` 已指向 Outfit，但字体文件还没打进客户端资源，浏览器会退到系统栈
- **信息架构**：颜色变了，布局和导航结构还是 dsh 的

### 暗色

设计稿只有亮色。CSS 里的暗色一段由亮色调板推导（同色相族、赭红提亮），不是设计产出。设计稿补了暗色之后应当整体替换那一段。

## 切换 llm 适配器后的验收

`cordis.yml` 停用了 `llm-deepseek`、只走 `llm-pi-ai`（理由在那个文件里）。三项要实测：

1. **推理档位还在** —— 模型下拉旁边的 `High` 选择器。[twin-adapters note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) 记录直连适配器暴露 `thinking`/`reasoningEffort` 两个旋钮而 pi-ai 只有一个 `reasoning` level；那是 2026-06 的记录，pi-ai 现在有 `reasoningEfforts`、`thinkingBudgets` 与 `getSupportedThinkingLevels`，大概率已追平
2. **`claude-sonnet-4-5` 出现在模型下拉里** —— catalog route 从本地目录答，不需要 Anthropic key
3. **新会话的缓存命中率** —— 底栏那个百分比

⚠️ **老会话的缓存命中会掉。** replay state 只在历史 route 与目标 route 由同一个 `PiAiAdapter` 实例拥有时才传递；`deepseek-official` 记的历史换到 `deepseek` 之后拿不到原生复用。新会话不受影响。同一个道理，以后做「按场景选模型」时**跨 provider 切换会丢 KV cache**，路由策略不能只看单价。
