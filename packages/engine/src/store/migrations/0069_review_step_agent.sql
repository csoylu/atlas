-- #334: no project review agent. The reviewer of a task is the agent chosen in the workflow step that gives the
-- verdict (« Verdict on the PR », config.verdict), set as the task's reviewer when that step starts. Master: steps are
-- generic lego parts, so the reviewer's own PRs go through an ordinary Condition and a second agent step, not a rule.
-- Nobody's review changes on the day of the update: each step gets the project's review agent of today, and the
-- second step its lead (who reviewed the review agent's own PRs until now).

-- 1. Every agent step « The project's review agent » gets that agent (null: none was set, the step says so) and the
--    verdict switch; the old flag goes.
UPDATE workflow_nodes
   SET config = json_remove(
         json_set(config,
           '$.agentId', (SELECT p.review_agent FROM workflows w JOIN projects p ON p.id = w.project_id WHERE w.id = workflow_nodes.workflow_id),
           '$.verdict', json('true')),
         '$.reviewAgent')
 WHERE kind = 'agent' AND json_extract(config, '$.reviewAgent') = 1;

-- 2. Each default Review workflow with its « review » step and no « own » condition yet gets « Built by another
--    agent? » in front of it and « Review the reviewer's PR » (the project's lead) beside it, both exits like the first.
CREATE TEMP TABLE m334 AS
SELECT w.id AS wf, p.review_agent AS reviewer, p.lead AS lead,
       (SELECT json_extract(config, '$.prompt') FROM workflow_nodes WHERE workflow_id = w.id AND id = 'review') AS prompt,
       -- Untouched default layout (design v47): moved to the nine-step layout of #334. Else the two new steps go right of it.
       (SELECT COUNT(*) FROM workflow_nodes n WHERE n.workflow_id = w.id AND (
          (n.id = 'review' AND n.x = 40 AND n.y = 288) OR (n.id = 'merge' AND n.x = 272 AND n.y = 288) OR
          (n.id = 'done' AND n.x = 504 AND n.y = 288) OR (n.id = 'back' AND n.x = 40 AND n.y = 496))) = 4 AS dflt,
       (SELECT MAX(x) FROM workflow_nodes WHERE workflow_id = w.id) + 232 AS freex,
       (SELECT y FROM workflow_nodes WHERE workflow_id = w.id AND id = 'review') AS ry
  FROM workflows w LEFT JOIN projects p ON p.id = w.project_id
 WHERE w.origin = 'review'
   AND EXISTS (SELECT 1 FROM workflow_nodes WHERE workflow_id = w.id AND id = 'review' AND kind = 'agent')
   AND NOT EXISTS (SELECT 1 FROM workflow_nodes WHERE workflow_id = w.id AND id IN ('own', 'review2'));

UPDATE workflow_edges SET to_node = 'own' WHERE to_node = 'review' AND workflow_id IN (SELECT wf FROM m334);

INSERT INTO workflow_edges (workflow_id, from_node, exit, to_node)
SELECT workflow_id, 'review2', exit, to_node FROM workflow_edges WHERE from_node = 'review' AND workflow_id IN (SELECT wf FROM m334);
INSERT INTO workflow_edges (workflow_id, from_node, exit, to_node) SELECT wf, 'own', 'yes', 'review' FROM m334;
INSERT INTO workflow_edges (workflow_id, from_node, exit, to_node) SELECT wf, 'own', 'no', 'review2' FROM m334;

INSERT INTO workflow_nodes (workflow_id, id, kind, x, y, config)
SELECT wf, 'own', 'condition', CASE WHEN dflt THEN 40 ELSE freex END, CASE WHEN dflt THEN 288 ELSE ry END,
       json_object('test', 'fields', 'title', 'Built by another agent?', 'match', 'all',
         'tests', json_array(json_object('field', 'task.assignee', 'op', 'isNot', 'value', COALESCE(reviewer, ''))))
  FROM m334;
INSERT INTO workflow_nodes (workflow_id, id, kind, x, y, config)
SELECT wf, 'review2', 'agent', CASE WHEN dflt THEN 272 ELSE freex END, CASE WHEN dflt THEN 496 ELSE ry + 208 END,
       json_object('title', 'Review the reviewer''s PR', 'agentId', lead, 'prompt', COALESCE(prompt, ''), 'newTaskEachRun', json('false'),
         'inThread', json('true'), 'verdict', json('true'))
  FROM m334;

UPDATE workflow_nodes SET x = 272 WHERE id = 'review' AND workflow_id IN (SELECT wf FROM m334 WHERE dflt);
UPDATE workflow_nodes SET x = 504 WHERE id = 'merge' AND workflow_id IN (SELECT wf FROM m334 WHERE dflt);
UPDATE workflow_nodes SET x = 736 WHERE id = 'done' AND workflow_id IN (SELECT wf FROM m334 WHERE dflt);

-- A graph changed under an open editor: its next save is refused as stale, not written over this one.
UPDATE workflows SET revision = revision + 1 WHERE id IN (SELECT wf FROM m334);
DROP TABLE m334;

-- 3. The project setting goes (Settings → Projects → Review agent).
ALTER TABLE projects DROP COLUMN review_agent;

-- 4. An Inbox item can carry one button into the app (#334: « Open the Review workflow » of a new project).
ALTER TABLE notifications ADD COLUMN link TEXT;
