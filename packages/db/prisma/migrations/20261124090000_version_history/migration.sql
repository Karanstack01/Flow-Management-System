-- Version history: keep the canvas and how each version was made.

-- AlterTable
ALTER TABLE "WorkflowVersion" ADD COLUMN     "canvas" JSONB,
ADD COLUMN     "note" TEXT;
