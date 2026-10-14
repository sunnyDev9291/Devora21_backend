-- Exact normalized company lookups for other-progress / search
CREATE INDEX IF NOT EXISTS resume_archives_company_lower
  ON resume_archives (lower(btrim("companyName")));
