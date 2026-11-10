-- llama-server checks the model name; use the one Can's local server serves.
UPDATE models SET name = 'Qwen3.6-35B-A3B-UD-Q4_K_M' WHERE id = 'local' AND name = 'local';
