/**
 * Logout API Route
 *
 * Clears auth cookie.
 */

import { NextResponse } from "next/server";

const AUTH_COOKIE_NAME = "vajra_auth";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete(AUTH_COOKIE_NAME);
  return response;
}
