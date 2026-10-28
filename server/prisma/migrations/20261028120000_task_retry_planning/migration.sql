-- AlterTable
ALTER TABLE `Task` ADD COLUMN `retryPlanningAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Task_status_retryPlanningAt_idx` ON `Task`(`status`, `retryPlanningAt`);
