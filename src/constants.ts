export const Protocol = {
  PORT: 6346,
  VERSION: "0.6",
  TTL: 7,
  HEADER_SIZE: 23,
  PONG_SIZE: 14,
  QUERY_HITS_FOOTER: 23,
  QRP_TABLE_SIZE: 8192,
  QRP_INFINITY: 7,
  HANDSHAKE_END: "\r\n\r\n",
};

export const MessageType = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HITS: 0x81,
  ROUTE_TABLE_UPDATE: 0x30,
};

export const QRPVariant = {
  RESET: 0,
  PATCH: 1,
};

export const KNOWN_CACHE_LIST = [
  "http://cache.jayl.de/g2/gwc.php",
  "http://cache.jayl.de/g2/gwc.php/",
  "http://gweb.4octets.co.uk/skulls.php",
  "http://gweb3.4octets.co.uk/gwc.php",
  "http://gweb4.4octets.co.uk/",
  "http://midian.jayl.de/g2/bazooka.php",
  "http://midian.jayl.de/g2/gwc.php",
  "http://p2p.findclan.net/skulls.php",
  "http://paper.gwc.dyslexicfish.net:3709/",
  "http://rock.gwc.dyslexicfish.net:3709/",
  "http://scissors.gwc.dyslexicfish.net:3709/",
  "http://skulls.gwc.dyslexicfish.net/skulls.php",
];
