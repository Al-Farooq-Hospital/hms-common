import { connect, JSONCodec, NatsConnection } from 'nats';

export interface Envelope<T = any> {
  service: string;
  at: string;
  actor?: string;
  data: T;
}
export type Handler = (env: Envelope, subject: string) => Promise<void> | void;

/**
 * Thin NATS wrapper. The service keeps working (events are dropped with a log line)
 * if NATS is not reachable, and reconnects in the background.
 */
export class Bus {
  private nc?: NatsConnection;
  private jc = JSONCodec<Envelope>();
  private subs: { subject: string; handler: Handler }[] = [];

  constructor(private service: string) {}

  start() {
    const url = process.env.NATS_URL || 'nats://nats:4222';
    connect({ servers: url, name: this.service, waitOnFirstConnect: true, maxReconnectAttempts: -1 })
      .then((nc) => {
        this.nc = nc;
        console.log(JSON.stringify({ service: this.service, msg: 'nats connected', url }));
        for (const s of this.subs) this.attach(s.subject, s.handler);
      })
      .catch((e) => console.error('nats connect failed', e));
  }

  publish(subject: string, data: unknown, actor?: string) {
    if (!this.nc) {
      console.warn(JSON.stringify({ service: this.service, msg: 'nats not ready, event dropped', subject }));
      return;
    }
    this.nc.publish(subject, this.jc.encode({ service: this.service, at: new Date().toISOString(), actor, data }));
  }

  subscribe(subject: string, handler: Handler) {
    this.subs.push({ subject, handler });
    if (this.nc) this.attach(subject, handler);
  }

  private attach(subject: string, handler: Handler) {
    // queue group => with N replicas of a service only one replica handles each event
    const sub = this.nc!.subscribe(subject, { queue: this.service });
    (async () => {
      for await (const m of sub) {
        try {
          await handler(this.jc.decode(m.data), m.subject);
        } catch (e) {
          console.error(JSON.stringify({ service: this.service, msg: 'event handler failed', subject: m.subject, err: String(e) }));
        }
      }
    })();
  }

  get connected() {
    return !!this.nc && !this.nc.isClosed();
  }
}
