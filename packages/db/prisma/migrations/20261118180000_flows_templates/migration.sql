-- Flow management (labels, drafts, trash, favourites), template library, canvas layout.

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "canvas" JSONB,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "isDraft" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "NotificationRule" ADD COLUMN     "canvasNodeId" TEXT;

-- CreateTable
CREATE TABLE "WorkflowFavorite" (
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowFavorite_pkey" PRIMARY KEY ("userId","workflowId")
);

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "builtInKey" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'General',
    "definition" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "canvas" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_builtInKey_key" ON "WorkflowTemplate"("builtInKey");

-- CreateIndex
CREATE INDEX "WorkflowTemplate_orgId_idx" ON "WorkflowTemplate"("orgId");

-- CreateIndex
CREATE INDEX "Workflow_orgId_deletedAt_idx" ON "Workflow"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRule_workflowId_canvasNodeId_key" ON "NotificationRule"("workflowId", "canvasNodeId");

-- AddForeignKey
ALTER TABLE "WorkflowFavorite" ADD CONSTRAINT "WorkflowFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowFavorite" ADD CONSTRAINT "WorkflowFavorite_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

