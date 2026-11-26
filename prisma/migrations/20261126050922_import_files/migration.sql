/*
  Warnings:

  - A unique constraint covering the columns `[file_key]` on the table `import_batch` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "import_batch" ADD COLUMN     "file_key" TEXT,
ADD COLUMN     "file_sha256" TEXT,
ADD COLUMN     "file_size_bytes" INTEGER,
ADD COLUMN     "file_status" TEXT,
ADD COLUMN     "file_status_note" TEXT,
ADD COLUMN     "file_stored_at" TIMESTAMP(3),
ADD COLUMN     "file_type" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "import_batch_file_key_key" ON "import_batch"("file_key");
