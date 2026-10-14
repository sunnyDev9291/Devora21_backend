-- Optional: speed up Saved Resumes jd= ILIKE filter
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS resume_archives_jd_trgm
  ON resume_archives USING gin ("jobDescription" gin_trgm_ops);
