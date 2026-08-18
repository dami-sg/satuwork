/**
 * 把插件对 Context 的类型扩展拉进编译单元。
 *
 * 这些插件是 cordis.yml 在运行时装的，TS 源码里一次也没 import 过，所以它们的
 * `declare module 'cordis'`（server / timer / loader 挂上去的字段）根本不会被加载，
 * 结果就是满屏 "Property 'server' does not exist on type 'Context'"。
 * 这里显式引一下类型；配合 tsconfig 里的 paths（`cordis` 别名到 @deepseek-ai/cordis），
 * 扩展才落在源码实际导入的那个 Context 上。
 */
import '@cordisjs/plugin-server'
import '@deepseek-ai/cordis-plugin-timer'
