-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "unique_key" TEXT,
    "result" TEXT,
    "last_error" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_unique_key_key" ON "job"("unique_key");

-- CreateIndex
CREATE INDEX "job_status_run_at_idx" ON "job"("status", "run_at");

-- CreateIndex
CREATE INDEX "job_name_created_at_idx" ON "job"("name", "created_at");
