-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "category_code" TEXT,
    "sub_category_code" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_tag" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by_id" UUID,
    "removed_at" TIMESTAMP(3),
    "removed_by_id" UUID,

    CONSTRAINT "record_tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_brand_id_archived_at_idx" ON "product"("brand_id", "archived_at");

-- CreateIndex
CREATE INDEX "record_tag_entity_type_entity_id_removed_at_idx" ON "record_tag"("entity_type", "entity_id", "removed_at");

-- CreateIndex
CREATE INDEX "record_tag_tag_id_removed_at_idx" ON "record_tag"("tag_id", "removed_at");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_tag" ADD CONSTRAINT "record_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "list_value"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
