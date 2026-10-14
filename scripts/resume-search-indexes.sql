-- Integrated Super Admin resume search (ILIKE / trigram)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS resume_archives_company_trgm
  ON resume_archives USING gin ("companyName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS resume_archives_title_trgm
  ON resume_archives USING gin ("jobTitle" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS resume_archives_filename_trgm
  ON resume_archives USING gin ("resumeFileName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS resume_archives_pdfname_trgm
  ON resume_archives USING gin ("pdfFileName" gin_trgm_ops);
