#!/bin/bash

# 生成 TypeScript 类型文件脚本
# 通过 cargo test 触发 ts-rs 的 #[ts(export)] 自动导出到 bindings/，
# 再复制到前端 src/types/generated/ 目录供 import 引用。
# .cargo/config.toml 中 TS_RS_LARGE_INT=number 将 i64 映射为 number。

# pipefail：管道中任一命令失败则整体失败（防止 cargo test 失败被后续 grep 掩盖）
set -eo pipefail

echo "Generating TypeScript types from Rust..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
SRC_TAURI_DIR="$PROJECT_DIR/src-tauri"
GENERATED_DIR="$PROJECT_DIR/src/types/generated"

# 1. cargo test 触发 ts-rs 的 #[ts(export)] 导出到 bindings/
#    只运行 export_bindings 测试，避免其他测试干扰
#    不再过滤输出：cargo test 的退出码直接决定脚本成败
cd "$SRC_TAURI_DIR"
# 清空 bindings/ 避免删除 #[ts(export)] 类型后旧文件残留
rm -rf bindings
cargo test export_bindings -- --nocapture

# 2. 校验 bindings/ 目录已生成且非空
if [ ! -d "bindings" ] || [ -z "$(ls -A bindings 2>/dev/null)" ]; then
  echo "ERROR: bindings/ 目录未生成，请检查 ts-rs 的 #[ts(export)] 注解" >&2
  exit 1
fi

# 3. 复制到前端 src/types/generated/
#    先清空 generated/ 避免删除类型后旧文件残留（与 bindings/ 清理配合）
mkdir -p "$GENERATED_DIR"
rm -f "$GENERATED_DIR"/*.ts
cp bindings/*.ts "$GENERATED_DIR/"

echo "Done! Types copied to src/types/generated/:"
ls -1 "$GENERATED_DIR/"
