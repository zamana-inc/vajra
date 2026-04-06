import { NextRequest, NextResponse } from "next/server";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function filterRequestHeaders(request: NextRequest, apiKey?: string): Headers {
  const headers = new Headers(request.headers);

  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return headers;
}

function filterResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete("connection");
  headers.delete("transfer-encoding");
  return headers;
}

async function proxyRequest(request: NextRequest, context: RouteContext): Promise<Response> {
  const baseUrl = process.env.VAJRA_API_URL || "http://localhost:3847";
  const apiKey = process.env.VAJRA_API_KEY;
  const { path } = await context.params;
  const upstreamUrl = `${normalizeBaseUrl(baseUrl)}/${path.join("/")}${request.nextUrl.search}`;

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: filterRequestHeaders(request, apiKey),
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to reach Vajra API" },
      { status: 502 },
    );
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: filterResponseHeaders(upstreamResponse.headers),
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}
