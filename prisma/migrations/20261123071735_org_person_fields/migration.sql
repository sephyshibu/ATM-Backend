-- AlterTable
ALTER TABLE "organisation" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "person" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';
