-- CreateTable
CREATE TABLE "import_mapping" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "import_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_mapping_kind_name_key" ON "import_mapping"("kind", "name");
