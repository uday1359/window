import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { loadConfig } from '../config/config';
import { redactString } from '../common/redact';

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 1_500_000;

export const AttachmentInput = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg']),
  // base64 of up to MAX_ATTACHMENT_BYTES (4/3 expansion plus padding)
  data: z.string().min(1).max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Attachment must be base64'),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

const SIGNATURES: Record<AttachmentInput['mediaType'], { magic: Buffer; ext: string }> = {
  'image/png': { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ext: 'png' },
  'image/jpeg': { magic: Buffer.from([0xff, 0xd8, 0xff]), ext: 'jpg' },
};

interface Decoded {
  mediaType: AttachmentInput['mediaType'];
  bytes: Buffer;
}

/**
 * Screenshots attached to tasks (FR-01). Images are stored under STORAGE_DIR/attachments/<taskId>;
 * MySQL keeps only metadata. The declared type must match the file signature, so nothing but a
 * real PNG or JPEG is ever stored or sent to a model.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger('Attachments');

  constructor(private readonly prisma: PrismaService) {}

  private root(): string {
    return resolve(loadConfig().STORAGE_DIR, 'attachments');
  }

  decode(inputs: AttachmentInput[]): Decoded[] {
    if (inputs.length > MAX_ATTACHMENTS) throw new BadRequestException(`At most ${MAX_ATTACHMENTS} screenshots can be attached`);
    return inputs.map((a, i) => {
      const bytes = Buffer.from(a.data, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new BadRequestException(`Screenshot ${i + 1} must be between 1 byte and ${MAX_ATTACHMENT_BYTES / 1_000_000} MB`);
      const sig = SIGNATURES[a.mediaType];
      if (!bytes.subarray(0, sig.magic.length).equals(sig.magic)) throw new BadRequestException(`Screenshot ${i + 1} is not a valid ${a.mediaType} file`);
      return { mediaType: a.mediaType, bytes };
    });
  }

  /** Writes files first, then rows; a failure removes the task's folder again. */
  async save(taskId: string, files: Decoded[]): Promise<void> {
    if (!files.length) return;
    const dir = join(this.root(), taskId);
    await mkdir(dir, { recursive: true });
    try {
      const rows = [];
      for (const [i, f] of files.entries()) {
        const name = `${i + 1}.${SIGNATURES[f.mediaType].ext}`;
        await writeFile(join(dir, name), f.bytes, { flag: 'wx' });
        rows.push({ taskId, mediaType: f.mediaType, sizeBytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex'), storagePath: `attachments/${taskId}/${name}` });
      }
      await this.prisma.taskAttachment.createMany({ data: rows });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  private absolute(storagePath: string): string {
    const storage = resolve(loadConfig().STORAGE_DIR);
    const full = resolve(storage, storagePath);
    // Defence in depth: stored paths are generated here, but never read outside STORAGE_DIR.
    if (!full.startsWith(storage + sep)) throw new NotFoundException('Attachment not found');
    return full;
  }

  /** Images for the planner, verified against their stored hash. */
  async forPlanning(taskId: string): Promise<Array<{ mediaType: 'image/png' | 'image/jpeg'; data: string }>> {
    const rows = await this.prisma.taskAttachment.findMany({ where: { taskId }, orderBy: { storagePath: 'asc' } });
    const out = [];
    for (const r of rows) {
      const bytes = await readFile(this.absolute(r.storagePath));
      if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new Error(`Attachment ${r.id} was modified on disk`);
      out.push({ mediaType: r.mediaType as 'image/png' | 'image/jpeg', data: bytes.toString('base64') });
    }
    return out;
  }

  async read(taskId: string, attachmentId: string): Promise<{ mediaType: string; bytes: Buffer }> {
    const row = await this.prisma.taskAttachment.findFirst({ where: { id: attachmentId, taskId } });
    if (!row) throw new NotFoundException('Attachment not found');
    return { mediaType: row.mediaType, bytes: await readFile(this.absolute(row.storagePath)) };
  }

  /** Called before tasks are deleted (retention); rows go with the task via FK cascade. */
  async deleteFiles(taskIds: string[]): Promise<void> {
    for (const id of taskIds) {
      await rm(join(this.root(), id), { recursive: true, force: true }).catch((err: Error) => this.logger.warn(redactString(`Could not delete attachments of ${id}: ${err.message}`)));
    }
  }
}
