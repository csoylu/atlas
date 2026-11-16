-- The human's id was 'can' (the first user's name); it is now 'user'. Their display name and a short description
-- live in settings (user_name, user_about), asked on first launch.
UPDATE messages SET author = 'user' WHERE author = 'can';
UPDATE cards SET created_by = 'user' WHERE created_by = 'can';
UPDATE canvases SET updated_by = 'user' WHERE updated_by = 'can';
UPDATE canvas_versions SET updated_by = 'user' WHERE updated_by = 'can';
UPDATE memory SET updated_by = 'user' WHERE updated_by = 'can';
UPDATE schedules SET created_by = 'user' WHERE created_by = 'can';
UPDATE card_events SET payload = replace(payload, '"by":"can"', '"by":"user"') WHERE payload LIKE '%"by":"can"%';
