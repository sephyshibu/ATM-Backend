-- AlterTable
ALTER TABLE "gate_result" ADD COLUMN     "note" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "import_mapping" ADD COLUMN     "value_maps" JSONB NOT NULL DEFAULT '{}';
