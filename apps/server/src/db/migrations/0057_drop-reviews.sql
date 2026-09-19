-- Reviews are blocks now (docs/design/blocks.md, step 3): a reviewer posts
-- one `review` block to the agent it reviewed, findings are threads on it,
-- and resolve/reopen are state changes. The review tables, their tools,
-- routes and injection prompts are gone. Hard cutover: rows are not
-- migrated.

DROP TABLE IF EXISTS review_thread_messages;
DROP TABLE IF EXISTS review_feedback_items;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS persona_review_resolutions;
DROP TABLE IF EXISTS persona_reviews;
