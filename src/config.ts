interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

export interface GnutellaConfig {
  httpPort: number;
  peers: Record<string, Peer>;
  caches: Record<string, { lastPush: number; lastPull: number }>;
}

export const CONFIG: GnutellaConfig = {
  httpPort: 8080,
  peers: {},
  caches: {
    "http://cache.jayl.de/g2/gwc.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://cache.jayl.de/g2/gwc.php/": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://gweb.4octets.co.uk/skulls.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://gweb3.4octets.co.uk/gwc.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://gweb4.4octets.co.uk/": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://midian.jayl.de/g2/bazooka.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://midian.jayl.de/g2/gwc.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://p2p.findclan.net/skulls.php": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://paper.gwc.dyslexicfish.net:3709/": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://rock.gwc.dyslexicfish.net:3709/": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://scissors.gwc.dyslexicfish.net:3709/": {
      lastPush: 0,
      lastPull: 0,
    },
    "http://skulls.gwc.dyslexicfish.net/skulls.php": {
      lastPush: 0,
      lastPull: 0,
    },
  },
};
