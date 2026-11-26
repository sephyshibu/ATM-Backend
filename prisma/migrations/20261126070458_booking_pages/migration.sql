-- CreateTable
CREATE TABLE "calendar_connection" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT,
    "refresh_token" TEXT NOT NULL,
    "scopes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "calendar_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_type" (
    "id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "duration_mins" INTEGER NOT NULL DEFAULT 30,
    "conferencing" TEXT NOT NULL DEFAULT 'GOOGLE_MEET',
    "custom_link" TEXT,
    "buffer_before_mins" INTEGER NOT NULL DEFAULT 0,
    "buffer_after_mins" INTEGER NOT NULL DEFAULT 0,
    "min_notice_mins" INTEGER NOT NULL DEFAULT 240,
    "date_range_days" INTEGER NOT NULL DEFAULT 20,
    "slot_increment_mins" INTEGER NOT NULL DEFAULT 30,
    "max_per_day" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "event_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rule" (
    "id" UUID NOT NULL,
    "event_type_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "availability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" UUID NOT NULL,
    "event_type_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "invitee_name" TEXT NOT NULL,
    "invitee_email" TEXT NOT NULL,
    "invitee_timezone" TEXT,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "meeting_url" TEXT,
    "external_event_id" TEXT,
    "manage_token" TEXT NOT NULL,
    "person_id" UUID,
    "brand_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "rescheduled_from" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_connection_user_id_provider_removed_at_idx" ON "calendar_connection"("user_id", "provider", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_type_token_key" ON "event_type"("token");

-- CreateIndex
CREATE UNIQUE INDEX "event_type_slug_key" ON "event_type"("slug");

-- CreateIndex
CREATE INDEX "event_type_host_user_id_archived_at_idx" ON "event_type"("host_user_id", "archived_at");

-- CreateIndex
CREATE INDEX "availability_rule_event_type_id_idx" ON "availability_rule"("event_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_manage_token_key" ON "booking"("manage_token");

-- CreateIndex
CREATE INDEX "booking_event_type_id_starts_at_idx" ON "booking"("event_type_id", "starts_at");

-- CreateIndex
CREATE INDEX "booking_host_user_id_starts_at_idx" ON "booking"("host_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "booking_invitee_email_idx" ON "booking"("invitee_email");

-- AddForeignKey
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
