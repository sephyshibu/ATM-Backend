-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "kb_status" TEXT NOT NULL DEFAULT 'not_started',
ADD COLUMN     "kb_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "dossier" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT,
    "file_key" TEXT,
    "file_name" TEXT,
    "file_type" TEXT,
    "content_type" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "status" TEXT NOT NULL,
    "status_note" TEXT,
    "fetch_attempts" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL,
    "import_batch_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "stored_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,
    "archive_reason" TEXT,

    CONSTRAINT "dossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_definition" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "group_code" TEXT NOT NULL,
    "help" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "refresh_days" INTEGER NOT NULL DEFAULT 180,
    "brand_field" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "fact_definition_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "fact" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "fact_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "source_tier_code" TEXT,
    "dossier_id" UUID,
    "evidence_date" DATE NOT NULL,
    "refresh_due" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'entered',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "import_batch_id" UUID,
    "entered_by_id" UUID,
    "entered_by_label" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_id" UUID,
    "verified_by_label" TEXT,
    "verified_at" TIMESTAMP(3),
    "self_verified" BOOLEAN NOT NULL DEFAULT false,
    "rejected_by_id" UUID,
    "rejected_by_label" TEXT,
    "rejected_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "fact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dossier_file_key_key" ON "dossier"("file_key");

-- CreateIndex
CREATE INDEX "dossier_brand_id_archived_at_idx" ON "dossier"("brand_id", "archived_at");

-- CreateIndex
CREATE INDEX "dossier_sha256_idx" ON "dossier"("sha256");

-- CreateIndex
CREATE INDEX "fact_brand_id_fact_key_entered_at_idx" ON "fact"("brand_id", "fact_key", "entered_at");

-- CreateIndex
CREATE INDEX "fact_status_refresh_due_idx" ON "fact"("status", "refresh_due");

-- CreateIndex
CREATE INDEX "brand_kb_status_idx" ON "brand"("kb_status");

-- AddForeignKey
ALTER TABLE "dossier" ADD CONSTRAINT "dossier_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact" ADD CONSTRAINT "fact_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact" ADD CONSTRAINT "fact_fact_key_fkey" FOREIGN KEY ("fact_key") REFERENCES "fact_definition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact" ADD CONSTRAINT "fact_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
