// Satuwork 的宿主侧锚点插件。
//
// 它现在几乎什么都不做，但**必须存在**：dsh 的 client-modules 服务是扫描
// 「宿主 Loader 的 entries」里声明了 dsh.client 的包，来决定往浏览器启动图
// (window.__DSH_BOOT__) 里放哪些客户端 bundle。只贡献补丁行的包不是 entry，
// 扫不到，客户端主题也就永远不会加载。
//
// 以后 Satuwork 的宿主侧插件（satu-kb、satu-scheduler…）会各自成为独立的行；
// 这一行只负责把包本身挂进树里。

export const name = 'satuwork-harness'

export function apply(ctx) {
  ctx.logger?.info?.('satuwork-harness: 宿主锚点已挂载，客户端主题随浏览器启动图下发')
}

export default { name, apply }
