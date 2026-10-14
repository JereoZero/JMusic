// API 入口：re-export 所有命令模块
// （原实现包含浏览器非 Tauri 环境的 mock-api 分支脚手架，已删除——
//   应用仅在 Tauri 环境运行，mock-api 无真实消费方，仅测试里的 vi.mock 引用其路径。）

import * as api from './modules'

export default api
export * from './modules'
