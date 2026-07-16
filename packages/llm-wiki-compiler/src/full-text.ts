import path from "node:path";
import { ingestBytes } from "./ingest.js";
import type {
  FullTextLocation,
  IngestResult,
  LiteratureMetadata,
  SearchResult,
  ServiceOptions,
} from "./types.js";
import { htmlToText } from "./utils.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

type DownloadableMediaType =
  | "application/pdf"
  | "text/html"
  | "text/plain"
  | "application/xml";

export interface FullTextOptions extends ServiceOptions {
  oaOnly: boolean;
  maxFileBytes: number;
  signal?: AbortSignal;
}

export interface FullTextAcquisition {
  imported: IngestResult;
  location: string;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
  );
}

function safeRemoteUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "host.docker.internal" ||
      isPrivateIpv4(hostname) ||
      isPrivateIpv6(hostname)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function mediaType(value: string | null): DownloadableMediaType | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "application/pdf") return normalized;
  if (normalized === "text/html" || normalized === "application/xhtml+xml")
    return "text/html";
  if (normalized === "text/plain") return normalized;
  if (
    normalized === "application/xml" ||
    normalized === "text/xml" ||
    normalized === "application/atom+xml"
  )
    return "application/xml";
  return undefined;
}

function metadata(
  result: SearchResult,
  location: FullTextLocation,
): LiteratureMetadata {
  const acquisitionProvider = location.source ?? result.provider;
  const providers = [
    ...new Set([
      acquisitionProvider,
      result.provider,
      ...(result.providers ?? []),
    ]),
  ];
  const sourceProvenance = [
    ...(result.sourceProvenance ?? []),
    {
      provider: acquisitionProvider,
      id: result.id,
      url: location.url,
    },
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.id === entry.id &&
          candidate.url === entry.url,
      ) === index,
  );
  return {
    id: result.id,
    title: result.title,
    url: result.url,
    provider: acquisitionProvider,
    ...(providers.length ? { providers } : {}),
    ...(result.doi ? { doi: result.doi } : {}),
    ...(result.arxivId ? { arxivId: result.arxivId } : {}),
    ...(result.openAlexId ? { openAlexId: result.openAlexId } : {}),
    ...(result.sourceId ? { sourceId: result.sourceId } : {}),
    ...(result.versionId ? { versionId: result.versionId } : {}),
    ...(result.authors?.length ? { authors: result.authors } : {}),
    ...(result.published ? { published: result.published } : {}),
    ...(result.year !== undefined ? { year: result.year } : {}),
    ...(result.venue ? { venue: result.venue } : {}),
    ...((result.license ?? location.license)
      ? { license: result.license ?? location.license }
      : {}),
    ...(result.openAccess === true || location.openAccess === true
      ? { openAccess: true }
      : result.openAccess === false
        ? { openAccess: false }
        : {}),
    ...(result.oaStatus ? { oaStatus: result.oaStatus } : {}),
    ...(result.citationCount !== undefined
      ? { citationCount: result.citationCount }
      : {}),
    sourceProvenance,
  };
}

function filename(
  result: SearchResult,
  url: string,
  type: DownloadableMediaType,
) {
  const extension =
    type === "application/pdf"
      ? ".pdf"
      : type === "text/html"
        ? ".html"
        : type === "application/xml"
          ? ".xml"
          : ".txt";
  let base = "";
  try {
    base = path.posix.basename(new URL(url).pathname);
  } catch {
    // The URL was validated before this helper; use the deterministic fallback.
  }
  if (!base || !/\.[A-Za-z0-9]{1,10}$/.test(base)) {
    base = `full-text-${result.id.replace(/[^A-Za-z0-9._-]/g, "-")}${extension}`;
  }
  return base;
}

function locationOrder(priority: string | undefined): number {
  return (
    { arxiv: 0, "openalex-best": 1, openalex: 2, other: 3 }[
      priority ?? "other"
    ] ?? 3
  );
}

function selectLocation(result: SearchResult, oaOnly: boolean) {
  return [...(result.fullTextLocations ?? [])]
    .filter(
      (location) =>
        location.kind !== "landing" &&
        Boolean(safeRemoteUrl(location.url)) &&
        (oaOnly
          ? location.openAccess === true
          : location.openAccess === true || Boolean(location.license)),
    )
    .sort((left, right) => {
      const priority =
        locationOrder(left.priority) - locationOrder(right.priority);
      if (priority) return priority;
      const kind = (value: string) =>
        value === "html" ? 0 : value === "pdf" ? 1 : 2;
      return (
        kind(left.kind) - kind(right.kind) || left.url.localeCompare(right.url)
      );
    })[0];
}

function combinedSignal(caller?: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(caller?.reason);
  const timer = setTimeout(abort, TIMEOUT_MS);
  if (caller) caller.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
}

async function fetchDownload(
  input: string,
  options: FullTextOptions,
): Promise<{
  data: Uint8Array;
  mediaType: DownloadableMediaType;
  url: string;
}> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("No fetch implementation is available");
  let url = input;
  const { signal, dispose } = combinedSignal(options.signal);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!safeRemoteUrl(url)) {
        throw new Error(
          "Full-text URL must use public HTTP(S) without embedded credentials",
        );
      }
      const response = await fetcher(url, {
        headers: {
          accept: "application/pdf,text/html,text/plain,application/xml",
        },
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location)
          throw new Error("Full-text redirect has no Location header");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok)
        throw new Error(`Full-text download failed: HTTP ${response.status}`);
      if (response.url && !safeRemoteUrl(response.url))
        throw new Error("Full-text final URL must remain public HTTP(S)");
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > options.maxFileBytes) {
        throw new Error(
          `Full-text download exceeds maxFileBytes (${length} > ${options.maxFileBytes})`,
        );
      }
      const type = mediaType(response.headers.get("content-type"));
      if (!type)
        throw new Error(
          `Unsupported full-text content type: ${response.headers.get("content-type") ?? "missing"}`,
        );
      const data = new Uint8Array(await response.arrayBuffer());
      if (!data.byteLength) throw new Error("Full-text download is empty");
      if (data.byteLength > options.maxFileBytes) {
        throw new Error(
          `Full-text download exceeds maxFileBytes (${data.byteLength} > ${options.maxFileBytes})`,
        );
      }
      if (
        type === "application/pdf" &&
        !Buffer.from(data.subarray(0, 5)).equals(Buffer.from("%PDF-"))
      ) {
        throw new Error("Downloaded PDF does not have a valid PDF signature");
      }
      if (type === "text/html") {
        let html: string;
        try {
          html = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          throw new Error("Downloaded HTML is not valid UTF-8");
        }
        const visibleText = htmlToText(html);
        if (
          visibleText.length < 1_000 ||
          /client challenge|javascript is disabled|enable javascript|captcha|access denied|required part of this site couldn.t load|sign in to continue/i.test(
            visibleText,
          )
        ) {
          throw new Error(
            "Downloaded HTML appears to be a landing, login, or challenge page rather than full text",
          );
        }
      }
      return { data, mediaType: type, url: response.url || url };
    }
    throw new Error(`Full-text download exceeded ${MAX_REDIRECTS} redirects`);
  } catch (error) {
    if (signal.aborted)
      throw new Error("Full-text download timed out or was aborted");
    throw error;
  } finally {
    dispose();
  }
}

/** Download one explicitly supplied OA full-text location and ingest its original bytes. */
export async function acquireFullText(
  result: SearchResult,
  options: FullTextOptions,
): Promise<FullTextAcquisition> {
  const location = selectLocation(result, options.oaOnly);
  if (!location) {
    throw new Error(
      options.oaOnly
        ? "No explicitly open-access downloadable full-text location"
        : "No explicitly licensed or open-access downloadable full-text location",
    );
  }
  const download = await fetchDownload(location.url, options);
  const imported = await ingestBytes(download.data, download.url, {
    ...(options.root ? { root: options.root } : {}),
    title: result.title,
    mediaType: download.mediaType,
    provenanceKind: "search",
    url: download.url,
    provider: location.source ?? result.provider,
    fileName: filename(result, download.url, download.mediaType),
    literature: metadata(result, location),
    ...(options.now ? { now: options.now } : {}),
  });
  return { imported, location: download.url };
}
