-- 添加文件大小列（字节）：与 file_mtime 配合用于增量扫描。
-- 仅比对 mtime 会在「内容变但 mtime 不变」的场景（cp -p / rsync -t / 恢复备份）
-- 漏判，导致 DB 元数据永久陈旧。补 file_size 后，mtime 相同但 size 不同也重扫。
ALTER TABLE songs ADD COLUMN file_size INTEGER;