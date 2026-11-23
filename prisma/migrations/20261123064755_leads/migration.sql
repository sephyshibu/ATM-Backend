-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "person_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'outbound',
    "stage" TEXT NOT NULL,
    "lane" TEXT,
    "lane_until" DATE,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stage_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "import_batch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_move" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "move_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_stage" TEXT,
    "from_lane" TEXT,
    "from_until" DATE,
    "from_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "to_stage" TEXT NOT NULL,
    "to_lane" TEXT,
    "to_until" DATE,
    "to_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason_code" TEXT,
    "reason" TEXT,
    "event_key" TEXT,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    "undone_by_id" UUID,
    "undo_of_id" UUID,

    CONSTRAINT "lead_move_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_brand_id_idx" ON "lead"("brand_id");

-- CreateIndex
CREATE INDEX "lead_stage_lane_idx" ON "lead"("stage", "lane");

-- CreateIndex
CREATE UNIQUE INDEX "lead_move_event_key_key" ON "lead_move"("event_key");

-- CreateIndex
CREATE INDEX "lead_move_lead_id_at_idx" ON "lead_move"("lead_id", "at");

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_move" ADD CONSTRAINT "lead_move_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
