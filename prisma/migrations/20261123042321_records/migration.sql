-- CreateTable
CREATE TABLE "organisation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "hq_country" TEXT,
    "linkedin_url" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "category_code" TEXT,
    "sub_category_code" TEXT,
    "routing_code" TEXT,
    "home_country" TEXT,
    "home_revenue_usd" BIGINT,
    "revenue_year" INTEGER,
    "asian_markets_live" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tier_code" TEXT,
    "owner_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "description" TEXT NOT NULL DEFAULT '',
    "linkedin_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL DEFAULT '',
    "job_title" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "email_status" TEXT NOT NULL DEFAULT 'unknown',
    "phone" TEXT,
    "linkedin_url" TEXT,
    "country" TEXT,
    "buying_role_code" TEXT,
    "consent_code" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_person" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by_id" UUID,
    "removed_at" TIMESTAMP(3),
    "removed_by_id" UUID,

    CONSTRAINT "brand_person_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organisation_name_idx" ON "organisation"("name");

-- CreateIndex
CREATE INDEX "organisation_domain_idx" ON "organisation"("domain");

-- CreateIndex
CREATE INDEX "brand_organisation_id_idx" ON "brand"("organisation_id");

-- CreateIndex
CREATE INDEX "brand_domain_idx" ON "brand"("domain");

-- CreateIndex
CREATE INDEX "brand_archived_at_idx" ON "brand"("archived_at");

-- CreateIndex
CREATE INDEX "person_organisation_id_idx" ON "person"("organisation_id");

-- CreateIndex
CREATE INDEX "person_email_idx" ON "person"("email");

-- CreateIndex
CREATE INDEX "brand_person_brand_id_removed_at_idx" ON "brand_person"("brand_id", "removed_at");

-- CreateIndex
CREATE INDEX "brand_person_person_id_removed_at_idx" ON "brand_person"("person_id", "removed_at");

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_person" ADD CONSTRAINT "brand_person_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_person" ADD CONSTRAINT "brand_person_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
