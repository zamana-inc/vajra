import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MANAGED_SKILL_PREFIX = "vajra-";
const MANAGED_SKILL_TARGETS = [
  ".codex/skills",
  ".claude/skills",
] as const;
const EXCLUDE_BLOCK_START = "# BEGIN Vajra managed skills";
const EXCLUDE_BLOCK_END = "# END Vajra managed skills";
const EXCLUDE_BLOCK = `${EXCLUDE_BLOCK_START}
/.codex/skills/vajra-*/
/.claude/skills/vajra-*/
${EXCLUDE_BLOCK_END}`;

export function builtInSkillsRoot(): string {
  return path.resolve(__dirname, "..", "skills");
}

async function listManagedSkills(skillsRoot: string): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillNames = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(MANAGED_SKILL_PREFIX))
    .map((entry) => entry.name)
    .sort();

  if (skillNames.length === 0) {
    throw new Error(`no managed Vajra skills found in ${skillsRoot}`);
  }

  for (const skillName of skillNames) {
    const skillPath = path.join(skillsRoot, skillName, "SKILL.md");
    let fileStat;
    try {
      fileStat = await stat(skillPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`managed skill is missing SKILL.md: ${skillPath}`);
      }
      throw error;
    }

    if (!fileStat.isFile()) {
      throw new Error(`managed skill SKILL.md must be a file: ${skillPath}`);
    }
  }

  return skillNames;
}

async function syncSkillTarget(opts: {
  workspacePath: string;
  skillsRoot: string;
  targetRoot: string;
  skillNames: string[];
}): Promise<void> {
  const targetRootPath = path.join(opts.workspacePath, opts.targetRoot);
  await mkdir(targetRootPath, { recursive: true });

  const existingEntries = await readdir(targetRootPath, { withFileTypes: true });
  await Promise.all(existingEntries
    .filter((entry) => entry.name.startsWith(MANAGED_SKILL_PREFIX) && !opts.skillNames.includes(entry.name))
    .map((entry) => rm(path.join(targetRootPath, entry.name), { recursive: true, force: true })));

  for (const skillName of opts.skillNames) {
    const sourcePath = path.join(opts.skillsRoot, skillName);
    const destinationPath = path.join(targetRootPath, skillName);
    const [sourceDigest, destinationDigest] = await Promise.all([
      directoryDigest(sourcePath),
      directoryDigest(destinationPath),
    ]);
    if (sourceDigest && sourceDigest === destinationDigest) {
      continue;
    }
    await rm(destinationPath, { recursive: true, force: true });
    await cp(sourcePath, destinationPath, { recursive: true, force: true });
  }
}

async function collectFilesRecursive(rootPath: string, currentPath: string = rootPath): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      return collectFilesRecursive(rootPath, entryPath);
    }

    if (entry.isFile()) {
      return [entryPath];
    }

    return [];
  }));

  return files.flat().sort((left, right) => left.localeCompare(right));
}

async function directoryDigest(directoryPath: string): Promise<string | null> {
  try {
    const directoryStat = await stat(directoryPath);
    if (!directoryStat.isDirectory()) {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const files = await collectFilesRecursive(directoryPath);
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(path.relative(directoryPath, filePath));
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function resolveGitDir(workspacePath: string): Promise<string | null> {
  const dotGitPath = path.join(workspacePath, ".git");

  try {
    const dotGitStat = await stat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }

    if (!dotGitStat.isFile()) {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const dotGitContent = await readFile(dotGitPath, "utf8");
  const match = dotGitContent.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return null;
  }

  return path.resolve(workspacePath, match[1]);
}

async function ensureGitInfoExclude(workspacePath: string): Promise<void> {
  const gitDir = await resolveGitDir(workspacePath);
  if (!gitDir) {
    return;
  }

  const excludePath = path.join(gitDir, "info", "exclude");
  await mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const managedBlockPattern = new RegExp(
    `${EXCLUDE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${EXCLUDE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "g",
  );
  const trimmed = existing.replace(managedBlockPattern, "").trimEnd();
  const nextContent = [trimmed, EXCLUDE_BLOCK].filter(Boolean).join("\n\n") + "\n";
  await writeFile(excludePath, nextContent, "utf8");
}

export async function syncBuiltInSkillsToWorkspace(
  workspacePath: string,
  skillsRoot: string = builtInSkillsRoot(),
): Promise<void> {
  const skillNames = await listManagedSkills(skillsRoot);

  for (const targetRoot of MANAGED_SKILL_TARGETS) {
    await syncSkillTarget({
      workspacePath,
      skillsRoot,
      targetRoot,
      skillNames,
    });
  }

  await ensureGitInfoExclude(workspacePath);
}
