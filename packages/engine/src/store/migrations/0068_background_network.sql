-- Change pending (#308, #298 §2.5): the internet level a background command started with, in its workspace. A
-- command keeps its sandbox until it ends, so Settings → Workspaces shows « Change pending » while one runs on a
-- level that is no longer the workspace's. NULL = an unsandboxed command (no project) or one from before #308.
ALTER TABLE background_processes ADD COLUMN project_id TEXT;
ALTER TABLE background_processes ADD COLUMN network TEXT CHECK (network IN ('on', 'hosts', 'off'));
