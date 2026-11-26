-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "home_revenue_max_usd" BIGINT,
ALTER COLUMN "domain" DROP NOT NULL;

-- CreateTable
CREATE TABLE "field_rule" (
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "field_rule_pkey" PRIMARY KEY ("entity","key")
);
