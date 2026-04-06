import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { CommandRunner } from "./process";

export function extractBinary(commandTemplate: string): string {
  const [binary] = commandTemplate.trim().split(/\s+/, 1);
  return binary.replace(/^['"]|['"]$/g, "");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function splitCommandTokens(command: string): string[] {
  return command.match(/(?:'[^']*'|"[^"]*"|\\.|[^\s])+/g) ?? [];
}

export function joinCommandTokens(tokens: string[]): string {
  return tokens.filter(Boolean).join(" ");
}

export function tokenValue(token: string): string {
  return token.replace(/^['"]|['"]$/g, "");
}

export function tokenBasename(token: string): string {
  return path.basename(tokenValue(token));
}

export function insertArgsAfterBinary(command: string, args: string[]): string {
  const trimmed = command.trim();
  if (!trimmed || args.length === 0) {
    return trimmed;
  }

  const binaryMatch = trimmed.match(/^((?:'[^']*'|"[^"]*"|\\.|[^\s])+)([\s\S]*)$/);
  if (!binaryMatch) {
    return [trimmed, ...args.map((entry) => shellQuote(entry))].join(" ");
  }

  const [, binary, remainder] = binaryMatch;
  return [
    binary,
    ...args.map((entry) => shellQuote(entry)),
    remainder.trimStart(),
  ].filter(Boolean).join(" ");
}

export async function isCommandTemplateAvailable(
  commandTemplate: string,
  runner: CommandRunner,
): Promise<boolean> {
  const binary = extractBinary(commandTemplate);
  if (!binary) {
    return false;
  }

  if (binary.includes("/")) {
    try {
      await access(binary, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const result = await runner.run(`command -v ${binary}`, {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
