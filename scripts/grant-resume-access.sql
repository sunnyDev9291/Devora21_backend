-- Grant resume builder access to one user (run in pgAdmin Query Tool)
UPDATE "User"
SET "resumeBuilderEnabled" = true,
    "updatedAt" = NOW()
WHERE email = 'user@example.com';

-- Grant access to multiple users
UPDATE "User"
SET "resumeBuilderEnabled" = true,
    "updatedAt" = NOW()
WHERE email IN (
  'user1@example.com',
  'user2@example.com'
);

-- Revoke access
UPDATE "User"
SET "resumeBuilderEnabled" = false,
    "updatedAt" = NOW()
WHERE email = 'user@example.com';

-- List users who can use resume builder
SELECT id, email, "firstName", "lastName", "emailVerified", "resumeBuilderEnabled"
FROM "User"
WHERE "resumeBuilderEnabled" = true
ORDER BY email;

-- List signed-in users waiting for approval
SELECT id, email, "firstName", "lastName", "emailVerified", "resumeBuilderEnabled", "createdAt"
FROM "User"
WHERE "resumeBuilderEnabled" = false
ORDER BY "createdAt" DESC;
