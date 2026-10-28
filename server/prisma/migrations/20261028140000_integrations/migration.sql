-- CreateTable
CREATE TABLE `Integration` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(32) NOT NULL,
    `kind` ENUM('REST', 'MCP') NOT NULL,
    `description` VARCHAR(500) NOT NULL DEFAULT '',
    `baseUrl` VARCHAR(500) NOT NULL,
    `allowedPaths` JSON NOT NULL,
    `allowedTools` JSON NOT NULL,
    `authHeader` VARCHAR(64) NULL,
    `authScheme` VARCHAR(32) NULL,
    `secretRef` VARCHAR(100) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Integration_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
