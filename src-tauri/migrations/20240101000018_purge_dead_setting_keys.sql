-- 清除死设置键（与 ALLOWED_SETTING_KEYS 收紧配套）。
--
-- 这 5 个键零读取方（2026-10-14 优化专项 O7 逐一 grep 确认）：
--   secondary_folders —— 二级文件夹是主目录下的符号链接，不是设置项
--   theme / volume    —— 存前端 zustand-persist（localStorage），从不走 IPC
--   language          —— 无 i18n 实现
--   last_scan          —— 无任何读取方
-- 历史版本可能写过它们，删行零影响；白名单同步收紧为只允许 music_folder。
DELETE FROM settings WHERE key IN (
    'secondary_folders',
    'theme',
    'language',
    'volume',
    'last_scan'
);
