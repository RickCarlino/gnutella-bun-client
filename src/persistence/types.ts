export type PersistedConfig = {
  listen_ip?: unknown;
  listen_host?: unknown;
  listen_port?: unknown;
  advertised_ip?: unknown;
  advertised_host?: unknown;
  advertised_port?: unknown;
  blocked_ips?: unknown;
  gwebcache_urls?: unknown;
  ultrapeer?: unknown;
  max_connections?: unknown;
  max_ultrapeer_connections?: unknown;
  max_leaf_connections?: unknown;
  max_ttl?: unknown;
  enable_tls?: unknown;
  log_ignore?: unknown;
  data_dir?: unknown;
};

export type PersistedState = {
  servent_id_hex?: unknown;
  peers?: unknown;
};

export type PersistedDoc = {
  config?: PersistedConfig;
  state?: PersistedState;
};
