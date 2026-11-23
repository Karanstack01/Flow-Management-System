-- Super admin + organization lifecycle/licence + organization-scoped job runs.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "licenseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "maxUsers" INTEGER,
ADD COLUMN     "maxWorkflows" INTEGER,
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activeOrgId" TEXT,
ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "requestedBy" TEXT;

-- CreateIndex
CREATE INDEX "User_isSuperAdmin_idx" ON "User"("isSuperAdmin");

-- CreateIndex
CREATE INDEX "JobRun_orgId_startedAt_idx" ON "JobRun"("orgId", "startedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_activeOrgId_fkey" FOREIGN KEY ("activeOrgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data: an existing installation must not be left without a super admin.
-- Promote the oldest active user who holds the ADMIN capability, only if none exists yet.
UPDATE "User" SET "isSuperAdmin" = true
WHERE "id" = (
  SELECT u."id"
  FROM "User" u
  JOIN "UserGroup" ug ON ug."userId" = u."id"
  JOIN "Group" g ON g."id" = ug."groupId"
  WHERE u."isActive" = true AND 'ADMIN' = ANY (g."capabilities")
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "User" WHERE "isSuperAdmin" = true);
