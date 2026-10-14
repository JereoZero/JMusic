//! 应用内日志缓冲区：把 tracing 事件收进有界内存环形队列，供设置页「日志」标签展示。
//!
//! # 为什么不再写 SQLite（`app_logs` 表）
//!
//! 原方案靠前端主动调 `add_log` 命令写库，但后端 Rust 从未调用过它 —— `app_logs`
//! 表零写入方，日志面板与「复制日志」始终无数据可看（功能等于失效）。改为由
//! tracing subscriber 直接捕获后，任何 `info!/warn!/error!` 都自动进面板，
//! 无需逐处插桩，也不会再漏。
//!
//! # 为什么是内存而不是落库
//!
//! - **有界**：固定 [`MAX_LOG_ENTRIES`] 条，超出丢最旧。扫描大曲库时 info 日志量很大
//!   （每个阶段都有汇总），落库会长期膨胀 —— 旧 `app_logs` 无上限轮转正是已记录的隐患。
//! - **无阻塞**：写库要走 async 通道 + 后台任务，而 tracing 的写入点遍布扫描/播放热路径；
//!   内存 push 只是一次加锁，代价可忽略。
//! - 日志面板是调试视图，重启后清空可接受。

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;
use ts_rs::TS;

/// 缓冲区上限。前端默认拉 100 条、「复制日志」取 100 条，
/// 500 足够覆盖一次完整扫描的日志量，又不会占内存。
pub const MAX_LOG_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AppLog {
    // SQLite INTEGER 序列化为 JSON number（不会超 2^55），覆盖 ts-rs 10.x 默认的 bigint
    #[ts(type = "number")]
    pub id: i64,
    pub level: String,
    pub message: String,
    pub target: Option<String>,
    pub created_at: DateTime<Utc>,
}

struct Buffer {
    entries: VecDeque<AppLog>,
    next_id: i64,
}

/// 锁中毒（其他线程 panic 时）不 unwrap：降级为空缓冲，
/// 日志面板暂时无数据，但不影响扫描/播放等主流程。
static BUFFER: Mutex<Buffer> = Mutex::new(Buffer {
    entries: VecDeque::new(),
    next_id: 1,
});

impl Buffer {
    /// 仅测试用：生产代码的全局缓冲是 `static Mutex<Buffer>`（const 初始化）。
    #[cfg(test)]
    fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            next_id: 1,
        }
    }

    fn push(&mut self, level: &str, message: String, target: Option<String>) {
        if self.entries.len() >= MAX_LOG_ENTRIES {
            self.entries.pop_front();
        }
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push_back(AppLog {
            id,
            level: level.to_string(),
            message,
            target,
            created_at: Utc::now(),
        });
    }

    /// 按级别过滤 + 取最新 `limit` 条（新→旧），与设置页列表顺序一致。
    fn get(&self, level: Option<&str>, limit: Option<i64>) -> Vec<AppLog> {
        let limit = limit
            .filter(|&l| l > 0)
            .unwrap_or(100)
            .min(MAX_LOG_ENTRIES as i64) as usize;
        self.entries
            .iter()
            .rev()
            .filter(|e| level.is_none_or(|l| e.level == l))
            .take(limit)
            .cloned()
            .collect()
    }

    fn clear(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        n
    }
}

/// 全局访问入口：逻辑全部委托给 [`Buffer`] 的方法，
/// 便于测试用本地实例验证（避免共享 static 导致并行测试互相干扰）。
pub fn get_logs(level: Option<&str>, limit: Option<i64>) -> Vec<AppLog> {
    let Ok(buf) = BUFFER.lock() else {
        return Vec::new();
    };
    buf.get(level, limit)
}

pub fn clear() -> usize {
    let Ok(mut buf) = BUFFER.lock() else { return 0 };
    buf.clear()
}

/// tracing Layer：把事件的 message 抽出来送进缓冲区。
pub struct LogLayer;

/// 从事件里取出 `message` 字段。
///
/// `info!("共 {} 首", n)` 这类宏调用把格式化结果记进名为 `message` 的字段，
/// 且经 `record_debug` 递送 —— `format_args!` 的 Debug 即其 Display 输出，
/// 所以 `format!("{:?}", v)` 不会多出引号。
#[derive(Default)]
struct MessageVisitor {
    message: String,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
        }
    }

    // 显式覆盖 record_str：默认实现会转调 record_debug，
    // 给 &str 字段加上引号（"xxx"），对 message 字段是干扰。
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        }
    }
}

impl<S> Layer<S> for LogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        if visitor.message.is_empty() {
            return;
        }
        if let Ok(mut buf) = BUFFER.lock() {
            buf.push(
                meta.level().as_str(),
                visitor.message,
                Some(meta.target().to_string()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 逻辑全部作用在本地 Buffer 实例上：此前用共享的全局 static，
    // 并行测试互相清空/追加导致断言随机失败（与 useSongCover 缓存测试同款问题）。

    #[test]
    fn get_logs_returns_newest_first_and_respects_limit() {
        let mut buf = Buffer::new();
        buf.push("INFO", "first".into(), None);
        buf.push("WARN", "second".into(), None);
        buf.push("ERROR", "third".into(), None);

        let logs = buf.get(None, Some(2));
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].message, "third", "应为新→旧");
        assert_eq!(logs[1].message, "second");
    }

    #[test]
    fn get_logs_filters_by_level() {
        let mut buf = Buffer::new();
        buf.push("INFO", "a".into(), None);
        buf.push("ERROR", "b".into(), None);
        buf.push("INFO", "c".into(), None);

        let errors = buf.get(Some("ERROR"), None);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "b");

        let infos = buf.get(Some("INFO"), None);
        assert_eq!(infos.len(), 2);
    }

    #[test]
    fn get_logs_clamps_non_positive_limit() {
        let mut buf = Buffer::new();
        buf.push("INFO", "x".into(), None);
        // limit=0 / 负数按未指定处理，走默认 100，不返回空
        assert_eq!(buf.get(None, Some(0)).len(), 1);
        assert_eq!(buf.get(None, Some(-5)).len(), 1);
        // 超过上限的 limit 也应被夹到 MAX_LOG_ENTRIES
        assert_eq!(buf.get(None, Some(i64::MAX)).len(), 1);
    }

    #[test]
    fn buffer_drops_oldest_when_full() {
        let mut buf = Buffer::new();
        // 推满 + 1 条，最早的应被挤掉
        for i in 0..=MAX_LOG_ENTRIES {
            buf.push("INFO", format!("msg-{i}"), None);
        }
        let logs = buf.get(None, Some(MAX_LOG_ENTRIES as i64));
        assert_eq!(logs.len(), MAX_LOG_ENTRIES, "条数应被封顶");
        assert_eq!(logs[0].message, "msg-500", "最新一条");
        assert_eq!(
            logs.last().unwrap().message,
            "msg-1",
            "最旧的 msg-0 应已被丢弃，msg-1 是现存最旧"
        );
    }

    #[test]
    fn clear_empties_buffer_and_reports_count() {
        let mut buf = Buffer::new();
        buf.push("INFO", "a".into(), None);
        buf.push("INFO", "b".into(), None);
        assert_eq!(buf.clear(), 2);
        assert!(buf.get(None, None).is_empty());
    }

    #[test]
    fn ids_are_monotonic_even_after_dropping() {
        let mut buf = Buffer::new();
        for i in 0..=MAX_LOG_ENTRIES {
            buf.push("INFO", format!("m{i}"), None);
        }
        let logs = buf.get(None, Some(MAX_LOG_ENTRIES as i64));
        // 返回顺序是新→旧，所以 id 应严格递减；且首条 id 必须是最后分配的
        assert_eq!(logs[0].id, (MAX_LOG_ENTRIES + 1) as i64, "首条为最新 id");
        for pair in logs.windows(2) {
            assert!(
                pair[1].id < pair[0].id,
                "丢最旧后 id 仍应严格递减（前端按 key 使用，不能重复）"
            );
        }
        assert_eq!(logs.last().unwrap().id, 2, "msg-0(id=1) 已被丢弃");
    }
}
