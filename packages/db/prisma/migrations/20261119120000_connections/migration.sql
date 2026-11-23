-- Settings > Connections (Cloudinary, Google/Microsoft mail, RedLava WhatsApp) and per-file storage provider.

-- AlterTable
ALTER TABLE "FileObject" ADD COLUMN     "storageMeta" JSONB,
ADD COLUMN     "storageProvider" TEXT NOT NULL DEFAULT 'local';

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connection_orgId_kind_idx" ON "Connection"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_orgId_provider_key" ON "Connection"("orgId", "provider");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

