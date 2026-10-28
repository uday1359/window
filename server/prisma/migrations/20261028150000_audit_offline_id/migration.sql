-- AlterTable
ALTER TABLE `AuditEvent` ADD COLUMN `offlineId` CHAR(36) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `AuditEvent_offlineId_key` ON `AuditEvent`(`offlineId`);
