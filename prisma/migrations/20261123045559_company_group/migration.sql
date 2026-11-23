-- AlterTable
ALTER TABLE "organisation" ADD COLUMN     "excluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "excluded_at" TIMESTAMP(3),
ADD COLUMN     "excluded_by_id" UUID,
ADD COLUMN     "exclusion_reason" TEXT,
ADD COLUMN     "legal_entity" TEXT,
ADD COLUMN     "parent_id" UUID;

-- CreateIndex
CREATE INDEX "organisation_parent_id_idx" ON "organisation"("parent_id");

-- AddForeignKey
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
