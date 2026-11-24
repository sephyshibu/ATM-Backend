-- AlterTable
ALTER TABLE "lead_move" ADD COLUMN     "is_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recommendation" TEXT;

-- CreateTable
CREATE TABLE "gate_definition" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checks" TEXT NOT NULL DEFAULT '',
    "stage" TEXT NOT NULL,
    "rule" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "gate_definition_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "gate_result" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "gate_code" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT 'unknown',
    "applies" BOOLEAN NOT NULL DEFAULT true,
    "not_applicable_reason" TEXT,
    "evidence" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'default',
    "set_by_id" UUID,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_change" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "gate_code" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "reason_code" TEXT,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gate_result_lead_id_gate_code_key" ON "gate_result"("lead_id", "gate_code");

-- CreateIndex
CREATE INDEX "gate_change_lead_id_at_idx" ON "gate_change"("lead_id", "at");
