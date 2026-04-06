/**
 * Login API Route
 *
 * Validates password and sets auth cookie.
 */

import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE_NAME = "vajra_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    if (!password) {
      return NextResponse.json({ error: "Password required" }, { status: 400 });
    }

    const correctPassword = process.env.DASHBOARD_PASSWORD;

    if (!correctPassword) {
      console.error("DASHBOARD_PASSWORD environment variable not set");
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      );
    }

    if (password !== correctPassword) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const token = generateToken(correctPassword);

    const response = NextResponse.json({ success: true });
    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

function generateToken(password: string): string {
  let hash = 0;
  const str = `vajra_${password}_auth`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `vauth_${Math.abs(hash).toString(36)}`;
}
