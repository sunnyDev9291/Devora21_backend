import {
  PutObjectCommand,
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, backblazeEnabled } from "../config/env";
import { AppError } from "../middleware/errorHandler";

export { backblazeEnabled };

type B2Auth = {
  accountId: string;
  apiUrl: string;
  authorizationToken: string;
  bucketId: string | null;
  s3ApiUrl: string;
  downloadUrl: string;
  region: string;
};

let authCache: { value: B2Auth; expiresAt: number } | null = null;
let s3Client: S3Client | null = null;

function sanitizeObjectName(name: string): string {
  return name.replace(/[^\w.\-()+ ]+/g, "_").replace(/\s+/g, "_").slice(0, 180);
}

function buildFriendlyUrl(downloadUrl: string, key: string): string {
  return `${downloadUrl}/file/${env.B2_BUCKET}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function authorizeB2(): Promise<B2Auth> {
  if (authCache && authCache.expiresAt > Date.now()) {
    return authCache.value;
  }

  if (!backblazeEnabled) {
    throw new AppError(503, "Backblaze B2 is not configured");
  }

  const basic = Buffer.from(
    `${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`,
    "utf8"
  ).toString("base64");

  const response = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    method: "GET",
    headers: { Authorization: `Basic ${basic}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AppError(502, `Backblaze authorize failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    accountId?: string;
    apiUrl?: string;
    authorizationToken?: string;
    downloadUrl?: string;
    s3ApiUrl?: string;
    allowed?: { bucketId?: string };
  };

  if (
    !data.accountId ||
    !data.apiUrl ||
    !data.authorizationToken ||
    !data.downloadUrl ||
    !data.s3ApiUrl
  ) {
    throw new AppError(502, "Backblaze authorize response incomplete");
  }

  const regionMatch = data.s3ApiUrl.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  const region = regionMatch?.[1] || "us-east-005";

  const value: B2Auth = {
    accountId: data.accountId,
    apiUrl: data.apiUrl.replace(/\/$/, ""),
    authorizationToken: data.authorizationToken,
    bucketId: data.allowed?.bucketId || null,
    s3ApiUrl: data.s3ApiUrl.replace(/\/$/, ""),
    downloadUrl: data.downloadUrl.replace(/\/$/, ""),
    region,
  };

  // Auth tokens last ~24h; refresh early.
  authCache = { value, expiresAt: Date.now() + 20 * 60 * 60 * 1000 };
  s3Client = null;
  return value;
}

async function getS3Client(): Promise<S3Client> {
  const auth = await authorizeB2();
  if (!s3Client) {
    s3Client = new S3Client({
      region: auth.region,
      endpoint: auth.s3ApiUrl,
      credentials: {
        accessKeyId: env.B2_KEY_ID!,
        secretAccessKey: env.B2_APPLICATION_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

async function uploadBufferToBackblaze(input: {
  userId: string;
  archiveId: string;
  fileName: string;
  buffer: Buffer;
  contentType: string;
}): Promise<{ key: string; url: string }> {
  const key = `resumes/${input.userId}/${input.archiveId}/${sanitizeObjectName(input.fileName)}`;
  const auth = await authorizeB2();
  const client = await getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET!,
      Key: key,
      Body: input.buffer,
      ContentType: input.contentType,
      ContentDisposition: `attachment; filename="${sanitizeObjectName(input.fileName)}"`,
    })
  );

  // Always persist the stable friendly URL in DB. Client-facing links are
  // generated via createBackblazeDownloadUrl (signed) because the bucket is private.
  const friendlyUrl = buildFriendlyUrl(auth.downloadUrl, key);
  return { key, url: friendlyUrl };
}

export async function uploadPdfToBackblaze(input: {
  userId: string;
  archiveId: string;
  pdfFileName: string;
  pdfBuffer: Buffer;
}): Promise<{ key: string; pdfUrl: string }> {
  const uploaded = await uploadBufferToBackblaze({
    userId: input.userId,
    archiveId: input.archiveId,
    fileName: input.pdfFileName,
    buffer: input.pdfBuffer,
    contentType: "application/pdf",
  });
  return { key: uploaded.key, pdfUrl: uploaded.url };
}

export async function uploadDocxToBackblaze(input: {
  userId: string;
  archiveId: string;
  docxFileName: string;
  docxBuffer: Buffer;
}): Promise<{ key: string; docxUrl: string }> {
  const uploaded = await uploadBufferToBackblaze({
    userId: input.userId,
    archiveId: input.archiveId,
    fileName: input.docxFileName,
    buffer: input.docxBuffer,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return { key: uploaded.key, docxUrl: uploaded.url };
}

/** Extract object key from a B2 friendly or S3-style URL. */
function extractKeyFromBackblazeUrl(fileUrl: string): string | null {
  try {
    const parsed = new URL(fileUrl);
    const bucket = env.B2_BUCKET;
    if (!bucket) return null;

    // Friendly: https://fXXX.backblazeb2.com/file/{bucket}/{key}
    const filePrefix = `/file/${bucket}/`;
    if (parsed.pathname.startsWith(filePrefix)) {
      return decodeURIComponent(parsed.pathname.slice(filePrefix.length));
    }

    // Path-style S3: https://s3.region.backblazeb2.com/{bucket}/{key}
    const pathPrefix = `/${bucket}/`;
    if (parsed.pathname.startsWith(pathPrefix)) {
      return decodeURIComponent(parsed.pathname.slice(pathPrefix.length));
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Build a Backblaze download URL that works without Devora auth.
 * Uses a download-authorization token on the friendly fXXX.backblazeb2.com URL
 * (true allPublic buckets are blocked on accounts with no payment history).
 */
export async function createBackblazeDownloadUrl(storedUrl: string): Promise<string> {
  const key = extractKeyFromBackblazeUrl(storedUrl);
  if (!key || !backblazeEnabled) {
    return storedUrl;
  }

  const auth = await authorizeB2();
  let bucketId = auth.bucketId;

  if (!bucketId) {
    const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
      method: "POST",
      headers: {
        Authorization: auth.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: auth.accountId,
        bucketName: env.B2_BUCKET,
      }),
    });
    if (listRes.ok) {
      const listed = (await listRes.json()) as {
        buckets?: Array<{ bucketId: string }>;
      };
      bucketId = listed.buckets?.[0]?.bucketId || null;
    }
  }

  if (bucketId) {
    const duration = Math.min(Math.max(1, env.B2_PRESIGN_EXPIRES_SECONDS), 604_800);
    const tokenRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
      method: "POST",
      headers: {
        Authorization: auth.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucketId,
        fileNamePrefix: key,
        validDurationInSeconds: duration,
      }),
    });

    if (tokenRes.ok) {
      const tokenBody = (await tokenRes.json()) as { authorizationToken?: string };
      if (tokenBody.authorizationToken) {
        const friendly = buildFriendlyUrl(auth.downloadUrl, key);
        return `${friendly}?Authorization=${encodeURIComponent(tokenBody.authorizationToken)}`;
      }
    }
  }

  // Fallback: S3-compatible presigned URL (also on Backblaze).
  const client = await getS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.B2_BUCKET!,
      Key: key,
    }),
    { expiresIn: Math.min(Math.max(1, env.B2_PRESIGN_EXPIRES_SECONDS), 604_800) }
  );
}

/**
 * Download a previously uploaded resume file from Backblaze.
 * Prefers authenticated S3 GetObject so private buckets still work.
 */
export async function downloadBackblazeFileByUrl(fileUrl: string): Promise<Buffer> {
  const opened = await openBackblazeReadStream(fileUrl);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) {
    throw new AppError(502, "Empty file from Backblaze");
  }
  return buffer;
}

/**
 * Open a readable stream for a Backblaze object (faster than buffering whole files).
 */
export async function openBackblazeReadStream(fileUrl: string): Promise<{
  stream: NodeJS.ReadableStream;
  contentLength?: number;
}> {
  const key = extractKeyFromBackblazeUrl(fileUrl);

  if (key && backblazeEnabled) {
    try {
      const client = await getS3Client();
      const out = await client.send(
        new GetObjectCommand({
          Bucket: env.B2_BUCKET!,
          Key: key,
        })
      );
      const body = out.Body;
      if (!body) {
        throw new AppError(502, "Empty file from Backblaze");
      }
      return {
        stream: body as NodeJS.ReadableStream,
        contentLength:
          typeof out.ContentLength === "number" ? out.ContentLength : undefined,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Fall through to HTTP fetch
    }
  }

  let response: Response;
  try {
    response = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new AppError(502, "Could not reach file storage");
  }

  if (!response.ok) {
    throw new AppError(502, `Could not download file from storage (${response.status})`);
  }
  if (!response.body) {
    throw new AppError(502, "Empty file from storage");
  }

  const { Readable } = await import("node:stream");
  return {
    stream: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    contentLength: Number(response.headers.get("content-length") || "") || undefined,
  };
}
