-- v3: Excalidraw is gone. Canvases that held only drawings are deleted (their versions and whiteboard documents go
-- with them, ON DELETE CASCADE); drawing nodes are dropped from the others and from their kept versions, in place.
-- Diagrams are svg documents now.
DELETE FROM canvases
WHERE json_array_length(nodes) > 0
  AND NOT EXISTS (SELECT 1 FROM json_each(canvases.nodes) WHERE json_extract(value, '$.kind') <> 'drawing');
-- Explicit too, in case foreign keys are off while migrating.
DELETE FROM canvas_versions WHERE canvas_id NOT IN (SELECT id FROM canvases);
DELETE FROM document_versions WHERE doc_id IN (SELECT id FROM documents WHERE canvas_id IS NOT NULL AND canvas_id NOT IN (SELECT id FROM canvases));
DELETE FROM panel_tabs WHERE doc_id IN (SELECT id FROM documents WHERE canvas_id IS NOT NULL AND canvas_id NOT IN (SELECT id FROM canvases));
DELETE FROM documents WHERE canvas_id IS NOT NULL AND canvas_id NOT IN (SELECT id FROM canvases);
UPDATE canvases
SET nodes = (SELECT json_group_array(json(value)) FROM json_each(canvases.nodes) WHERE json_extract(value, '$.kind') <> 'drawing')
WHERE EXISTS (SELECT 1 FROM json_each(canvases.nodes) WHERE json_extract(value, '$.kind') = 'drawing');
UPDATE canvas_versions
SET nodes = (SELECT json_group_array(json(value)) FROM json_each(canvas_versions.nodes) WHERE json_extract(value, '$.kind') <> 'drawing')
WHERE EXISTS (SELECT 1 FROM json_each(canvas_versions.nodes) WHERE json_extract(value, '$.kind') = 'drawing');
