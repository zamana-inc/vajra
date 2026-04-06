import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { builtInSkillsRoot } from "../src/skills";

test("bundled Vajra skills exist with required metadata", async () => {
  const skillsRoot = builtInSkillsRoot();
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const requiredSkills = [
    "vajra-code-review",
    "vajra-doc-review",
    "vajra-document",
    "vajra-fix",
    "vajra-implement",
    "vajra-plan",
    "vajra-plan-review",
    "vajra-prepare-pr",
    "vajra-revise",
  ];

  for (const skillName of requiredSkills) {
    assert.ok(skillNames.includes(skillName), `expected bundled skill ${skillName}`);
  }

  for (const skillName of skillNames) {
    const skillBody = await readFile(path.join(skillsRoot, skillName, "SKILL.md"), "utf8");
    assert.match(skillBody, /^---\nname:\s+[^\n]+\ndescription:\s+[^\n]+\n---\n/s);
    assert.match(skillBody, new RegExp(`^---\\nname:\\s+${skillName}\\n`, "m"));
  }
});
