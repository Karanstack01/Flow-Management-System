-- Stage Jump: rework round per record stage.

-- AlterTable
ALTER TABLE "RecordStage" ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 0;

