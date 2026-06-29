// API 入口
// 检测运行环境并导出对应的 API 实现

import * as realApi from './modules'
import { mockApi } from './mock-api'

// 编译期类型检查：mockApi 必须实现 realApi 的所有公开方法
// invokeApi 是内部工具函数，前端不通过 api 对象调用，故排除
void (mockApi satisfies Omit<typeof realApi, 'invokeApi'>)

// 检测 Tauri 运行环境：
// - 用 `__TAURI_INTERNALS__` 而非 `__TAURI__`，前者是 Tauri 2.x IPC 底层机制，
//   无论 withGlobalTauri 是否开启都会注入；后者只在 withGlobalTauri=true 时存在。
//   因此本检测与 tauri.conf.json 中 withGlobalTauri=false 的安全配置解耦。
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const api = isTauri ? realApi : mockApi

export default api
export * from './modules'
