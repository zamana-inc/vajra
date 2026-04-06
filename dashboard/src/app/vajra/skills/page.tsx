"use client";

/**
 * Vajra Skills — create and edit reusable skill files.
 *
 * Left sidebar: skill list with quick previews.
 * Right editor: name + markdown body, mirroring the Agents page pattern.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { MarkdownEditor } from "@/components/editors/markdown-editor";
import { Button } from "@/components/dashboard/button";
import { ConfirmDialog } from "@/components/dashboard/dialog";
import {
  DocumentIcon,
  PlusIcon,
  SaveIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/design";
import { useVajra } from "@/lib/vajra";
import { deleteVajraSkill, saveVajraSkill } from "@/lib/vajra/client";
import type { VajraSkillDefinition, VajraSkillsResponse } from "@/lib/vajra/types";

interface SkillDraft {
  name: string;
  content: string;
}

function defaultSkillContent(name: string): string {
  const normalizedName = name.trim() || "vajra-new-skill";
  return [
    "---",
    `name: ${normalizedName}`,
    "description: Describe when to use this skill.",
    "---",
    "",
    `# ${normalizedName}`,
    "",
    "## Goal",
    "",
    "## Instructions",
    "- Add the concrete steps this skill should follow.",
    "",
  ].join("\n");
}

function skillToDraft(skill: VajraSkillDefinition): SkillDraft {
  return {
    name: skill.name,
    content: skill.content,
  };
}

function emptyDraft(): SkillDraft {
  const name = "vajra-new-skill";
  return {
    name,
    content: defaultSkillContent(name),
  };
}

function normalizeSkillNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function SkillCard({
  skill,
  selected,
  onClick,
}: {
  skill: VajraSkillDefinition;
  selected: boolean;
  onClick: () => void;
}) {
  const preview = skill.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && line !== "---" && !line.startsWith("name:") && !line.startsWith("description:")) ?? "";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 transition-colors duration-100 border-b border-[var(--d-border-subtle)]",
        selected ? "bg-[var(--d-bg-selected-strong)]" : "hover:bg-[var(--d-bg-hover)]",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{skill.name}</span>
      </div>
      <p className="text-[11px] font-mono text-[var(--d-text-tertiary)] mt-1 truncate">
        {skill.path.split("/").slice(-2).join("/")}
      </p>
      {preview && (
        <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1.5 truncate leading-relaxed">
          {preview}
        </p>
      )}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">{hint}</p>
      )}
    </div>
  );
}

function SkillEditor({
  draft,
  isNew,
  saving,
  deleting,
  error,
  hasChanges,
  onChange,
  onSave,
  onDelete,
  onReset,
}: {
  draft: SkillDraft;
  isNew: boolean;
  saving: boolean;
  deleting: boolean;
  error: string | null;
  hasChanges: boolean;
  onChange: (update: Partial<SkillDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-[17px] font-semibold text-[var(--d-text-primary)]">
              {isNew ? "New Skill" : draft.name}
            </h2>
            <p className="text-[12px] text-[var(--d-text-tertiary)] mt-0.5">
              {isNew ? "Create a reusable instruction file for Vajra agents" : "Edit skill instructions"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
                Discard
              </Button>
            )}
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={saving || deleting}
                icon={<TrashIcon />}
                className="text-[var(--d-error)] hover:text-[var(--d-error)] hover:bg-[var(--d-error-bg)]"
              >
                Delete
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={onSave}
              icon={<SaveIcon />}
              loading={saving}
              disabled={!hasChanges && !isNew}
            >
              {isNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">{error}</p>
          </div>
        )}

        <div className="space-y-5">
          <Field
            label="Name"
            hint="Lowercase slug. Must start with vajra-. The file is stored at <name>/SKILL.md."
          >
            <input
              type="text"
              value={draft.name}
              onChange={(event) => onChange({ name: normalizeSkillNameInput(event.target.value) })}
              disabled={!isNew}
              placeholder="vajra-plan-review"
              className={cn(
                "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[13px] font-mono text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                "disabled:opacity-60 disabled:bg-[var(--d-bg-subtle)]",
              )}
            />
          </Field>

          <Field
            label="Content"
            hint="Skill markdown consumed by Codex/Claude inside the workspace."
          >
            <div className="border border-[var(--d-border)] rounded-lg overflow-hidden bg-[var(--d-bg-surface)]">
              <MarkdownEditor
                value={draft.content}
                onChange={(value) => onChange({ content: value })}
              />
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

export default function VajraSkillsPage() {
  const searchParams = useSearchParams();
  const skillsData = useVajra<VajraSkillsResponse>("config/skills");

  const [selectedName, setSelectedName] = useState<string | null>(searchParams.get("skill"));
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [originalJson, setOriginalJson] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  const skills = skillsData.data?.skills ?? [];
  const skillNames = useMemo(
    () => skills.map((skill) => skill.name).sort(),
    [skills],
  );
  const skillsByName = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills],
  );

  useEffect(() => {
    if (!selectedName && skillNames.length > 0 && !isNew) {
      setSelectedName(skillNames[0]);
    }
  }, [isNew, selectedName, skillNames]);

  useEffect(() => {
    if (!selectedName) {
      return;
    }

    const selectedSkill = skillsByName.get(selectedName);
    if (!selectedSkill) {
      return;
    }

    const nextDraft = skillToDraft(selectedSkill);
    setDraft(nextDraft);
    setOriginalJson(JSON.stringify(nextDraft));
    setIsNew(false);
    setError(null);
  }, [selectedName, skillsByName]);

  const hasChanges = draft ? JSON.stringify(draft) !== originalJson : false;

  const handleSelect = (name: string) => {
    setSelectedName(name);
    setIsNew(false);
    window.history.replaceState(null, "", `/vajra/skills?skill=${encodeURIComponent(name)}`);
  };

  const handleNew = () => {
    const nextDraft = emptyDraft();
    setDraft(nextDraft);
    setOriginalJson(JSON.stringify(nextDraft));
    setSelectedName(null);
    setIsNew(true);
    setError(null);
    window.history.replaceState(null, "", "/vajra/skills");
  };

  const handleChange = (update: Partial<SkillDraft>) => {
    if (!draft) {
      return;
    }

    let nextDraft = { ...draft, ...update };
    if (
      isNew &&
      typeof update.name === "string" &&
      draft.content === defaultSkillContent(draft.name || "vajra-new-skill")
    ) {
      nextDraft = {
        ...nextDraft,
        content: defaultSkillContent(update.name || "vajra-new-skill"),
      };
    }

    setDraft(nextDraft);
  };

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) {
      setError("Skill name is required.");
      return;
    }
    if (!draft.name.startsWith("vajra-")) {
      setError("Skill name must start with vajra-.");
      return;
    }
    if (!draft.content.trim()) {
      setError("Skill content is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveVajraSkill(draft.name, draft.content);
      await skillsData.refetch();
      setSelectedName(draft.name);
      setIsNew(false);
      window.history.replaceState(null, "", `/vajra/skills?skill=${encodeURIComponent(draft.name)}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save skill.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedName) {
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      await deleteVajraSkill(selectedName);
      await skillsData.refetch();
      setSelectedName(null);
      setDraft(null);
      setShowDelete(false);
      window.history.replaceState(null, "", "/vajra/skills");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete skill.");
      setShowDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleReset = () => {
    if (selectedName) {
      const selectedSkill = skillsByName.get(selectedName);
      if (selectedSkill) {
        setDraft(skillToDraft(selectedSkill));
      }
      return;
    }

    if (isNew) {
      setDraft(emptyDraft());
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-[var(--d-bg-page)]">
      <div className="h-full flex">
        <div className="w-[280px] flex-shrink-0 border-r border-[var(--d-border)] bg-[var(--d-bg-surface)] flex flex-col">
          <div className="px-4 pt-5 pb-3 border-b border-[var(--d-border-subtle)]">
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                  Vajra
                </p>
                <h1 className="text-[17px] font-semibold text-[var(--d-text-primary)] tracking-tight">
                  Skills
                </h1>
              </div>
              <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={handleNew}>
                New
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {skillsData.loading ? (
              <div className="px-4 py-6">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="py-3 border-b border-[var(--d-border-subtle)]">
                    <div className="h-3.5 w-24 bg-[var(--d-bg-active)] rounded mb-2" />
                    <div className="h-3 w-36 bg-[var(--d-bg-active)] rounded mb-1.5" />
                    <div className="h-3 w-28 bg-[var(--d-bg-active)] rounded" />
                  </div>
                ))}
              </div>
            ) : skillNames.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <DocumentIcon className="w-8 h-8 mx-auto text-[var(--d-text-disabled)] mb-3" />
                <p className="text-[13px] text-[var(--d-text-tertiary)]">No skills defined</p>
                <p className="text-[11px] text-[var(--d-text-disabled)] mt-1">
                  Create one to get started
                </p>
              </div>
            ) : (
              skillNames.map((name) => {
                const skill = skillsByName.get(name);
                if (!skill) {
                  return null;
                }

                return (
                  <SkillCard
                    key={name}
                    skill={skill}
                    selected={name === selectedName && !isNew}
                    onClick={() => handleSelect(name)}
                  />
                );
              })
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          {draft ? (
            <SkillEditor
              draft={draft}
              isNew={isNew}
              saving={saving}
              deleting={deleting}
              error={error}
              hasChanges={hasChanges}
              onChange={handleChange}
              onSave={handleSave}
              onDelete={() => setShowDelete(true)}
              onReset={handleReset}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <DocumentIcon className="w-12 h-12 mx-auto text-[var(--d-text-disabled)] mb-4" />
                <p className="text-[15px] font-medium text-[var(--d-text-secondary)]">
                  Select a skill
                </p>
                <p className="text-[13px] text-[var(--d-text-tertiary)] mt-1">
                  or create a new one to get started
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        title={`Delete "${selectedName}"?`}
        description="This removes the skill directory from Vajra. Existing prompts that mention it will no longer have a matching skill file."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        destructive
        loading={deleting}
      />
    </div>
  );
}
