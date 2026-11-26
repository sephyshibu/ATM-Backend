-- CreateTable
CREATE TABLE "email_template" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,

    CONSTRAINT "email_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_template_version" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "opening_fallback" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_by_label" TEXT NOT NULL,
    "editor_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "approved_by_label" TEXT,
    "superseded_at" TIMESTAMP(3),
    "discarded_at" TIMESTAMP(3),

    CONSTRAINT "email_template_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_rule" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "category_code" TEXT NOT NULL DEFAULT '',
    "sub_category_code" TEXT NOT NULL DEFAULT '',
    "routing_code" TEXT NOT NULL DEFAULT '',
    "template_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "removed_at" TIMESTAMP(3),
    "removed_by_id" UUID,

    CONSTRAINT "template_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_template_kind_archived_at_idx" ON "email_template"("kind", "archived_at");

-- CreateIndex
CREATE INDEX "email_template_version_template_id_status_idx" ON "email_template_version"("template_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_template_version_template_id_version_key" ON "email_template_version"("template_id", "version");

-- CreateIndex
CREATE INDEX "template_rule_kind_removed_at_idx" ON "template_rule"("kind", "removed_at");

-- AddForeignKey
ALTER TABLE "email_template_version" ADD CONSTRAINT "email_template_version_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_rule" ADD CONSTRAINT "template_rule_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
