#!/usr/bin/env node
// 机器管家的启动器。
//
// 和 bot 那边一样，src/ 是 TypeScript，靠 `node --import tsx` 在运行时转——所以 tsx
// 是运行时依赖，不是构建工具，打包时必须跟着进去。
//
// 这里只有一行 import：真正的启动顺序在 src/index.ts 里（先起 HTTP 再配对，因为
// 配对时 Gateway 会立刻回拨一次确认可达）。
import './../src/index.ts'
