-- 添加文件修改时间列，用于增量扫描：跳过 mtime 未变的文件
ALTER TABLE songs ADD COLUMN file_mtime INTEGER;
