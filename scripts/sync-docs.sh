#!/bin/bash
# 自动同步全部文档的版本号
# 用法: bash scripts/sync-docs.sh
# 读取 package.json 的版本号，更新所有文档中的版本引用
#
# 注意：BUGS_HISTORY.md 按 `## v$VERSION` 条目组织，每版需手动添加内容，
#       本脚本不自动生成，由 pre-push 钩子强制检查其包含当前版本号。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

echo "Syncing docs to version $VERSION..."

# 1. 更新 docs/DEVELOPMENT_LOG.md 的版本头
if grep -q '\*\*当前版本\*\*' "$PROJECT_DIR/docs/DEVELOPMENT_LOG.md"; then
  perl -i -pe "s/\\*\\*当前版本\\*\\*: v[0-9]+\\.[0-9]+\\.[0-9]+/**当前版本**: v$VERSION/" "$PROJECT_DIR/docs/DEVELOPMENT_LOG.md"
fi

# 2. 更新 docs/BUGS.md 顶部的 `> 版本：vX.X.X` 行
if grep -q '^> 版本：v[0-9]' "$PROJECT_DIR/docs/BUGS.md"; then
  perl -i -pe "s/^> 版本：v[0-9]+\\.[0-9]+\\.[0-9]+/> 版本：v$VERSION/" "$PROJECT_DIR/docs/BUGS.md"
fi

# 3. 更新 docs/BUGS.md 顶部的 `> 最后更新：YYYY-MM-DD` 行为今天
TODAY=$(date +%Y-%m-%d)
if grep -q '^> 最后更新：' "$PROJECT_DIR/docs/BUGS.md"; then
  perl -i -pe "s/^> 最后更新：[0-9]{4}-[0-9]{2}-[0-9]{2}/> 最后更新：$TODAY/" "$PROJECT_DIR/docs/BUGS.md"
fi

printf "✅ Docs synced to v%s\n" "$VERSION"