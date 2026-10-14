-- 移除 app_logs 表（死表）。
--
-- 背景：app_logs 原本靠前端主动调 add_log 命令写入，但后端 Rust 从未调用过它，
-- 设置页「日志」标签与「复制日志」因此始终无数据可看（功能等于失效）。
--
-- 2026-10-14 修复：日志改为 tracing subscriber 直接捕获并写入内存环形缓冲
-- （见 src/app_log.rs），有界且零写库开销 —— 顺带解决了本表「无上限轮转」
-- 隐患：app_logs 无任何清理策略，长期会持续膨胀。
--
-- 该表从未有真实写入方，历史库里的数据也是空的，drop 不丢任何用户数据。
DROP INDEX IF EXISTS idx_app_logs_level;
DROP INDEX IF EXISTS idx_app_logs_created_at;
DROP TABLE IF EXISTS app_logs;
