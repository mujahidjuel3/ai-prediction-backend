CREATE TYPE "EmailDeliveryStatus" AS ENUM (
  'PENDING',
  'SENDING',
  'SMTP_ACCEPTED',
  'FAILED',
  'SUPPRESSED_PREFERENCE',
  'SKIPPED_DISABLED'
);

ALTER TABLE "Notification"
  ADD COLUMN "idempotencyKey" VARCHAR(120),
  ADD COLUMN "inAppVisible" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX "Notification_idempotencyKey_key"
  ON "Notification"("idempotencyKey");

CREATE TABLE "NotificationEmailDelivery" (
  "id" UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" VARCHAR(255),
  "lastErrorCode" VARCHAR(120),
  "acceptedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "NotificationEmailDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationEmailDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "NotificationEmailDelivery_notificationId_key"
  ON "NotificationEmailDelivery"("notificationId");
CREATE INDEX "NotificationEmailDelivery_status_updatedAt_idx"
  ON "NotificationEmailDelivery"("status", "updatedAt");
