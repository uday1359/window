import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { redact } from '../common/redact';

export interface DashboardEvent {
  type: string;
  [key: string]: unknown;
}

interface Subscriber {
  socket: WebSocket;
  userId: string;
  seesAll: boolean;
  sessionId: string;
}

/** Fan-out of live updates to dashboard WebSocket clients, scoped to the owning user. */
@Injectable()
export class EventsService {
  private readonly logger = new Logger('Events');
  private readonly subscribers = new Set<Subscriber>();

  add(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  subscriberList(): ReadonlyArray<Subscriber> {
    return [...this.subscribers];
  }

  /** Sends to the owner (and to users allowed to see everything). Payloads are redacted. */
  publish(ownerId: string | null, event: DashboardEvent): void {
    const data = JSON.stringify({ ...(redact(event) as DashboardEvent), at: new Date().toISOString() });
    for (const sub of this.subscribers) {
      if (ownerId !== null && sub.userId !== ownerId && !sub.seesAll) continue;
      if (sub.socket.readyState !== sub.socket.OPEN) continue;
      try {
        sub.socket.send(data);
      } catch (err) {
        this.logger.warn(`Failed to push event: ${(err as Error).message}`);
      }
    }
  }

  connectionCount(): number {
    return this.subscribers.size;
  }
}
