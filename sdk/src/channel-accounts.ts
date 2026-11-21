// Channel-account helper (issue #132).
//
// A Stellar transaction has exactly one source account, and that account's
// sequence number must be used exactly once per in-flight transaction.
// Submitting many escrows from one key therefore serialises on that key's
// sequence number (and reads stale sequences under concurrency). The
// standard fix is *channel accounts*: a pool of funded accounts that each
// source a share of the traffic, so N channels allow N transactions in
// flight.
//
// This pool hands out exclusive use of a channel for one operation at a
// time. It does not fetch or cache sequence numbers — `@stellar/stellar-sdk`
// reads the current sequence when it assembles a transaction — so exclusive
// checkout is what keeps concurrent submissions from reusing a sequence.
//
// No network access here; the load harness in `scripts/load/` uses it, and
// it is exported for integrators with the same problem.
import type { Keypair } from "@stellar/stellar-sdk";

export interface ChannelAccountPoolOptions {
  /** Throw instead of queueing when every channel is in use. */
  failFast?: boolean;
}

interface Waiter {
  resolve: (channel: Keypair) => void;
  reject: (error: Error) => void;
}

export class ChannelAccountPool {
  private readonly channels: Keypair[];
  private readonly idle: Keypair[];
  private readonly busy = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(channels: Keypair[], options: ChannelAccountPoolOptions = {}) {
    if (channels.length === 0) {
      throw new Error("ChannelAccountPool requires at least one channel account");
    }
    const publicKeys = channels.map((channel) => channel.publicKey());
    if (new Set(publicKeys).size !== publicKeys.length) {
      throw new Error("ChannelAccountPool does not accept duplicate channel accounts");
    }
    this.channels = [...channels];
    this.idle = [...channels];
    this.options = options;
  }

  private readonly options: ChannelAccountPoolOptions;

  /** Total channels in the pool. */
  get size(): number {
    return this.channels.length;
  }

  /** Channels currently checked out. */
  get inUse(): number {
    return this.busy.size;
  }

  /** Channels available right now. */
  get available(): number {
    return this.idle.length;
  }

  /**
   * Wait for an idle channel. Calls are served in order, so a queue of
   * operations shares the channels fairly instead of starving any one.
   */
  async acquire(): Promise<Keypair> {
    if (this.closed) {
      throw new Error("ChannelAccountPool is closed");
    }
    const channel = this.idle.shift();
    if (channel) {
      this.busy.add(channel.publicKey());
      return channel;
    }
    if (this.options.failFast) {
      throw new Error(`No idle channel accounts (all ${this.size} are in use)`);
    }
    return new Promise<Keypair>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Return a channel to the pool after its transaction has finished. */
  release(channel: Keypair): void {
    const publicKey = channel.publicKey();
    if (!this.busy.delete(publicKey)) {
      throw new Error(`Channel ${publicKey} is not checked out of this pool`);
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.busy.add(publicKey);
      waiter.resolve(channel);
    } else {
      this.idle.push(channel);
    }
  }

  /** Acquire a channel, run `fn`, and always release it afterwards. */
  async run<T>(fn: (channel: Keypair) => Promise<T>): Promise<T> {
    const channel = await this.acquire();
    try {
      return await fn(channel);
    } finally {
      this.release(channel);
    }
  }

  /** Reject every queued waiter; in-flight checkouts must still release. */
  close(reason = new Error("ChannelAccountPool is closed")): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(reason);
    }
  }
}
