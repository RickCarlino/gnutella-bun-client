import { firstSha1Urn, normalizeUrnList } from "./content_urn";

type ParsedMagnet = {
  uri: string;
  displayName?: string;
  search?: string;
  size?: number;
  urns: string[];
  sha1Urn?: string;
  exactSources: string[];
  alternateSources: string[];
};

type MagnetFields = {
  xt: string[];
  xs: string[];
  as: string[];
  dn: string[];
  kt: string[];
  size: string[];
};

type MagnetFieldKey = keyof MagnetFields;

const MAGNET_FIELD_BY_KEY: Record<string, MagnetFieldKey | undefined> = {
  xt: "xt",
  xs: "xs",
  as: "as",
  dn: "dn",
  kt: "kt",
  xl: "size",
  sz: "size",
  fs: "size",
};

function emptyMagnetFields(): MagnetFields {
  return {
    xt: [],
    xs: [],
    as: [],
    dn: [],
    kt: [],
    size: [],
  };
}

function normalizedMagnetKey(key: string): string {
  return key.toLowerCase().split(".", 1)[0] || "";
}

function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function pickFirst(values: string[]): string | undefined {
  return values.find((value) => value.length > 0);
}

function parseMagnetParams(raw: string):
  | {
      uri: string;
      params: URLSearchParams;
    }
  | undefined {
  const uri = raw.trim();
  if (!/^magnet:\?/i.test(uri)) return undefined;
  return {
    uri,
    params: new URLSearchParams(uri.slice(uri.indexOf("?") + 1)),
  };
}

function appendMagnetField(
  fields: MagnetFields,
  rawKey: string,
  rawValue: string,
): void {
  const key = MAGNET_FIELD_BY_KEY[normalizedMagnetKey(rawKey)];
  const value = rawValue.trim();
  if (!value || !key) return;
  fields[key].push(value);
}

function readMagnetFields(params: URLSearchParams): MagnetFields {
  const fields = emptyMagnetFields();
  for (const [rawKey, rawValue] of params.entries()) {
    appendMagnetField(fields, rawKey, rawValue);
  }
  return fields;
}

function parsedMagnetSize(fields: MagnetFields): number | undefined {
  return fields.size
    .map((value) => positiveInteger(value))
    .find((value) => value != null);
}

function hasMagnetPayload(
  fields: MagnetFields,
  urns: string[],
  displayName: string | undefined,
  search: string | undefined,
  size: number | undefined,
): boolean {
  return !!(
    urns.length ||
    displayName ||
    search ||
    size != null ||
    fields.xs.length ||
    fields.as.length
  );
}

function preferredMagnetUrn(urns: string[]): string | undefined {
  return (
    urns.find((urn) => urn.toLowerCase().startsWith("urn:bitprint:")) ||
    urns.find((urn) => urn.toLowerCase().startsWith("urn:sha1:")) ||
    urns[0]
  );
}

function appendMagnetSize(
  params: URLSearchParams,
  fileSize: number | undefined,
): void {
  if (fileSize == null || !Number.isFinite(fileSize) || fileSize < 0) {
    return;
  }
  params.set("xl", String(Math.floor(fileSize)));
}

export function parseMagnetUri(raw: string): ParsedMagnet | undefined {
  const parsed = parseMagnetParams(raw);
  if (!parsed) return undefined;
  const fields = readMagnetFields(parsed.params);
  const urns = normalizeUrnList(fields.xt);
  const displayName = pickFirst(fields.dn);
  const search = pickFirst(fields.kt) || displayName;
  const size = parsedMagnetSize(fields);
  if (!hasMagnetPayload(fields, urns, displayName, search, size))
    return undefined;
  const sha1Urn = firstSha1Urn(urns);
  return {
    uri: parsed.uri,
    ...(displayName ? { displayName } : {}),
    ...(search ? { search } : {}),
    ...(size != null ? { size } : {}),
    urns,
    ...(sha1Urn ? { sha1Urn } : {}),
    exactSources: fields.xs,
    alternateSources: fields.as,
  };
}

export function buildMagnetUri(input: {
  fileName?: string;
  fileSize?: number;
  search?: string;
  urns?: string[];
  sha1Urn?: string;
}): string {
  const params = new URLSearchParams();
  const urns = normalizeUrnList([
    ...(input.urns || []),
    ...(input.sha1Urn ? [input.sha1Urn] : []),
  ]);
  const primaryUrn = preferredMagnetUrn(urns);
  if (primaryUrn) params.set("xt", primaryUrn);
  appendMagnetSize(params, input.fileSize);
  if (input.fileName) params.set("dn", input.fileName);
  else if (input.search) params.set("kt", input.search);
  return `magnet:?${params.toString()}`;
}
