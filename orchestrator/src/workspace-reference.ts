import path from "node:path";

export function workspaceReference(workspacePath: string, filePath: string): string {
  const relative = path.relative(workspacePath, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return filePath;
}
