-- Notification delivery retries: attempt counter + last-change time for back-off and stale-claim recovery.

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "NotificationLog_status_updatedAt_idx" ON "NotificationLog"("status", "updatedAt");

