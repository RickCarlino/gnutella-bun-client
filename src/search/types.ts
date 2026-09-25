/** A detached summary of one independent search or browse operation. */
export type SearchSession = {
  id: string;
  number: number;
  kind: "query" | "browse";
  search: string;
  createdAt: number;
  status: "active" | "complete" | "failed";
  resultCount: number;
  error?: string;
};
