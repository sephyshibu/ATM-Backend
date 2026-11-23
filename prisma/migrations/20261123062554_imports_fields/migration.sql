-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "import_batch_id" UUID;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "import_batch_id" UUID,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "custom_field" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "help" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "retired_at" TIMESTAMP(3),
    "retired_by_id" UUID,

    CONSTRAINT "custom_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "brand_id" UUID,
    "file_name" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "row_count" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "rejected_count" INTEGER NOT NULL,
    "rejected" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_entity_type_key_key" ON "custom_field"("entity_type", "key");

-- CreateIndex
CREATE INDEX "import_batch_kind_created_at_idx" ON "import_batch"("kind", "created_at");
