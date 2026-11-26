-- AlterTable
ALTER TABLE "dossier" ADD COLUMN     "check_note" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "check_version_date" DATE,
ADD COLUMN     "checked_at" TIMESTAMP(3),
ADD COLUMN     "checked_by_id" UUID,
ADD COLUMN     "checked_by_label" TEXT,
ADD COLUMN     "google_file_id" TEXT,
ADD COLUMN     "self_checked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "dossier_brand_id_google_file_id_idx" ON "dossier"("brand_id", "google_file_id");
