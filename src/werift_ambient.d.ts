declare module "multicast-dns" {
  namespace mdns {
    interface MulticastDNS {
      destroy(): void;
      on(...args: unknown[]): unknown;
      query(...args: unknown[]): unknown;
      respond(...args: unknown[]): unknown;
    }
  }

  function mdns(...args: unknown[]): mdns.MulticastDNS;

  export default mdns;
}

declare module "werift-rtp/src/rtcp/rtpfb/nack" {
  export type GenericNack = unknown;
}
