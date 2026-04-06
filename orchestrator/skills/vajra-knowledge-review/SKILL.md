---
name: vajra-knowledge-review
description: Use for Vajra stages that critically review category knowledge drafts against repo instructions, target schemas, and the closest existing knowledge docs.
---

# Vajra Knowledge Review

You are reviewing a category knowledge draft. Your output is the edited draft itself, ready for human supervision in `experiments/knowledge/agent-drafts/`.

This is not a separate review memo. Edit the draft in place so it is materially better, more schema-aware, and more faithful to the repo's source material.

## Non-Negotiable Read Requirements

Before reviewing anything, you must read every file in `experiments/knowledge/instructions` completely and carefully.

Do not skim, sample, or stop early. That behavior is incorrect for this task. It is not possible to succeed without fully reading and understanding the instruction documents and historical logs in that directory.

### What the instruction files are

The files in `experiments/knowledge/instructions` are cleaned conversation logs between the project owner and an AI collaborator. They are not structured style guides. They are transcripts of real writing sessions where the owner demonstrated the quality bar, corrected mistakes, pushed back on generic output, and showed what good knowledge writing actually looks like for this repo.

Read them as the definitive reference for what the owner accepts and rejects. Pay attention to:

- what the owner corrected and why
- what patterns the owner praised or accepted
- what specific mistakes triggered pushback
- the level of specificity and schema-grounding the owner demanded

Your review should catch the same mistakes the owner catches in these logs. If the logs show the owner rejecting a particular pattern, and the draft uses that pattern, that is a review failure.

### Schema and extraction instructions

Then read the target category's schema and extraction instructions:

- `experiments/schemas/examples/<category>.jsonc`
- `experiments/schemas/examples/<category>.md`

### Closest existing knowledge docs

Then inspect the existing knowledge docs in `experiments/knowledge/`, identify the 2–3 closest examples to learn from, and read those examples fully. Choose examples based on product structure, buyer tradeoffs, and schema shape, not superficial keyword similarity. For example, if reviewing a throw pillows draft, cushions and decorative pillowcases are structurally closer than bedsheets — even though all are "textiles."

## Mindset

Review is where shallow category writing gets caught.

Your main job is to verify that the draft actually reflects:

- the instruction files — including the specific correction patterns demonstrated in the chat logs
- the target schema
- the extraction guide
- the strongest analogous examples already in the repo

The most valuable fixes are factual and structural:

- missing or weak schema references
- generic claims that are not grounded in the target schema
- missing tradeoffs
- missing field groups or important enum coverage
- misleading carryover from another category

## Process

### 1. Re-establish the category and source material

Infer the exact category slug from the issue title and description.

Read the instruction files, target schema, extraction guide, and closest existing example docs before trusting the draft.

### 2. Review the actual draft

Read `experiments/knowledge/agent-drafts/<category>.md`.

Check whether the draft is truly schema-aware:

- Are important schema fields referenced inline?
- Are enum values explained in practical terms?
- Does the doc distinguish high-signal vs. low-signal fields?
- Are red-flag combinations concrete and field-specific?
- Does it help a recommender reason, not just describe products?

### 3. Check against the chat log corrections

Compare the draft against the specific mistakes and corrections in the instruction chat logs. The logs show the owner catching problems in real time. Common patterns to watch for:

- Generic product education that could appear on any retail blog
- Claims that sound authoritative but are not tied to schema fields
- Borrowed reasoning from another category that doesn't apply here
- Missing coverage of fields or enum values that the schema treats as important

If the draft repeats a mistake the owner already corrected in the chat logs, that is the highest-priority fix.

### 4. Fix and tighten

Edit the draft in place.

Strengthen weak sections. Cut generic filler. Replace vague language with concrete schema-aware reasoning. Ensure the document learns from analogous categories without copying their category-specific conclusions.

### 5. Preserve the correct output boundary

The reviewed draft must remain in `experiments/knowledge/agent-drafts/<category>.md`.

Also copy the exact final reviewed draft to `.vajra/run/knowledge-draft.md` so the workflow has a stable artifact path.

Do not move, overwrite, or edit the curated docs in `experiments/knowledge/`.

## Quality Bar

Good review leaves behind a draft that:

- is materially grounded in the target schema
- reflects a full read of the instruction files
- uses the best existing docs as style references without copying them
- explains real category tradeoffs
- is concise, concrete, and useful for retrieval and recommendation

Bad review:

- rubber-stamps the writer's draft
- preserves generic or unsupported claims
- ignores missing schema coverage
- lets the draft sound polished while remaining shallow
- misses mistakes that the instruction chat logs explicitly show the owner correcting

## Rules

- Read every file in `experiments/knowledge/instructions` fully before reviewing.
- Read the target schema and extraction guide fully before reviewing.
- Read the closest existing example docs fully before reviewing.
- Edit the draft itself, not a separate review note.
- Keep the reviewed output under `experiments/knowledge/agent-drafts/`.
- Do not modify curated docs in `experiments/knowledge/`.
