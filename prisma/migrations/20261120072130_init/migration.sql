-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'deactivated');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "google_sub" TEXT,
    "invited_at" TIMESTAMP(3),
    "invited_by_id" UUID,
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "last_sign_in_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "deactivated_by_id" UUID,
    "deactivation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "key" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "test_only" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_definition" (
    "key" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "min" INTEGER,
    "max" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "setting_definition_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "setting_value" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "setting_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_definition" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parent_list_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "list_definition_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "list_value" (
    "id" UUID NOT NULL,
    "list_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "retired_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "list_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT,
    "ip" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_google_sub_key" ON "user"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "user_invite_token_hash_key" ON "user"("invite_token_hash");

-- CreateIndex
CREATE INDEX "user_status_idx" ON "user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "user_role_user_id_revoked_at_idx" ON "user_role"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_role_role_id_revoked_at_idx" ON "user_role"("role_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "setting_value_key_version_key" ON "setting_value"("key", "version");

-- CreateIndex
CREATE INDEX "list_value_list_key_retired_at_idx" ON "list_value"("list_key", "retired_at");

-- CreateIndex
CREATE UNIQUE INDEX "list_value_list_key_code_key" ON "list_value"("list_key", "code");

-- CreateIndex
CREATE INDEX "audit_event_at_idx" ON "audit_event"("at");

-- CreateIndex
CREATE INDEX "audit_event_section_idx" ON "audit_event"("section");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_deactivated_by_id_fkey" FOREIGN KEY ("deactivated_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permission"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setting_value" ADD CONSTRAINT "setting_value_key_fkey" FOREIGN KEY ("key") REFERENCES "setting_definition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_value" ADD CONSTRAINT "list_value_list_key_fkey" FOREIGN KEY ("list_key") REFERENCES "list_definition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_value" ADD CONSTRAINT "list_value_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "list_value"("id") ON DELETE SET NULL ON UPDATE CASCADE;
