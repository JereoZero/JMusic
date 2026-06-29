# 贡献指南

感谢你对 JlocalMusic 项目的关注！欢迎提交 Issue 和 Pull Request。

## 🐛 提交 Bug

在提交 Bug 之前，请先：

1. 搜索 [Issues](https://github.com/JereoZero/JMusic/issues) 确认是否已被报告
2. 确认你使用的是最新版本
3. 准备好以下信息：
   - 操作系统和版本
   - JlocalMusic 版本号
   - 复现步骤
   - 期望行为和实际行为
   - 截图或日志（如有）

## 💡 提交功能建议

1. 先搜索 Issues 确认是否已有类似建议
2. 详细描述功能需求和使用场景
3. 说明为什么这个功能对项目有价值

## 🔧 开发环境设置

### 前置要求

- Node.js 18+
- Rust 1.70+
- pnpm 或 npm

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/your-username/jlocal.git
cd jlocal

# 安装依赖
npm install

# 启动开发服务器
npm run tauri:dev
```

## 📝 代码规范

### TypeScript/React

- 使用 TypeScript，避免 `any` 类型
- 组件使用函数式组件 + Hooks
- 状态管理使用 Zustand
- 样式使用 Tailwind CSS

### Rust

- 遵循 Rust 标准格式化（`cargo fmt`）
- 使用 `clippy` 进行代码检查
- 异步代码使用 tokio 运行时
- 数据库操作使用 sqlx

### 提交信息

使用约定式提交：

```
feat: 添加新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式调整
refactor: 代码重构
test: 测试相关
chore: 构建/工具相关
```

## 🔄 Pull Request 流程

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### PR 检查清单

- [ ] 代码通过 `npm run lint` 检查
- [ ] 代码通过 `npm run typecheck` 类型检查
- [ ] 测试通过 `npm test`
- [ ] 提交信息符合约定式提交规范

## 🏗️ 项目架构

```
Jlocal/
├── src/                    # React 前端
│   ├── api/                # Tauri 命令调用
│   ├── components/         # UI 组件
│   ├── stores/             # Zustand 状态管理
│   └── views/              # 页面视图
└── src-tauri/              # Rust 后端
    └── src/
        ├── commands/       # Tauri 命令定义
        ├── database.rs     # SQLite 数据库
        ├── player.rs       # 音频播放器
        └── scanner.rs      # 文件扫描
```

## 📞 联系方式

如有问题，可以：
- 在 GitHub 上开 Issue
- 查看 [Wiki](https://github.com/your-username/jlocal/wiki)（如有）

---

再次感谢你的贡献！
