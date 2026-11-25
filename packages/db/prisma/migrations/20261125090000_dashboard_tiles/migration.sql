-- Dashboard link tiles (legacy Dashboard tab).

-- CreateTable
CREATE TABLE "DashboardTile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'link',
    "groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardTile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardTile_orgId_position_idx" ON "DashboardTile"("orgId", "position");

-- AddForeignKey
ALTER TABLE "DashboardTile" ADD CONSTRAINT "DashboardTile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;