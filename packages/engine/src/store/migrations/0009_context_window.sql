-- Context management (design §8): the model's context window, in tokens. The view sent to a model is compacted when
-- it passes 70 % of it. Anthropic models: 200k. Local servers: what they actually run with (Ollama and llama.cpp
-- default far below the model's maximum); a model test detects the real value from the server when it can.
ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 200000;
UPDATE models SET context_window = 32768 WHERE provider = 'openai_compat';
