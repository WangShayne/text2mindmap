export const DEFAULT_SYSTEM_PROMPT = `You turn the user's text into a mind-map outline written in Markdown.

Output rules (strict):
1. Output ONLY the Markdown outline. No preface, no explanation, no closing remarks, no code fences.
2. Start with exactly one level-1 heading ("# ") holding a short title for the whole text.
3. Use "##" and "###" headings for the main branches and nested "- " bullet lists (indented by 2 spaces per level) for details under them.
4. Every line must be a heading or a bullet item. No paragraphs, tables, blockquotes, images or horizontal rules.
5. Keep each node short: a key phrase or one short sentence (ideally under 20 words, or under 30 Chinese characters).
6. Cover all key ideas. Group related points, keep the original order where it matters, aim for 3-7 children per node and at most 5 levels.
7. Write in the same language as the input text (for Chinese input, answer in Chinese). Do not translate.
8. Do not add facts that are not in the text.`

export function chunkUserPrompt(chunk: string, index: number, total: number): string {
  return `This is part ${index + 1} of ${total} of a longer text. Outline ONLY this part, following the output rules. Use "# " for a short title of this part.\n\n---\n\n${chunk}`
}

export function mergeUserPrompt(outlines: string[]): string {
  return `Below are Markdown outlines of ${outlines.length} consecutive parts of ONE long text. Merge them into a single mind-map outline that follows the output rules: one "# " title for the whole text, merge duplicate or overlapping topics, keep the important details and the overall order.\n\n${outlines
    .map((o, i) => `<!-- part ${i + 1} -->\n${o}`)
    .join('\n\n')}`
}

export const EXPAND_SYSTEM_PROMPT = `You expand one node of a mind map. Output ONLY a nested Markdown bullet list ("- " items, 2 spaces of indent per level) with the new child nodes of the target node: 3-7 direct children, at most 2 more levels below them. No headings, no preface, no explanation, no code fences. Keep nodes short. Do not repeat children that already exist. Write in the same language as the mind map.`

export function expandUserPrompt(path: string[], existingChildren: string[], docMarkdown: string, extra?: string): string {
  return [
    `Target node path (root > ... > target): ${path.join(' > ')}`,
    existingChildren.length ? `Existing children of the target (do not repeat): ${existingChildren.join(' | ')}` : 'The target has no children yet.',
    extra ? `Extra instructions from the user: ${extra}` : '',
    `The whole mind map for context:\n\n${docMarkdown}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------- v0.5 transcript modes ----------

const SOURCE_RULE = 'Each transcript line starts with its id in square brackets, like [s12]. End every line you write (except the "# " title) with the ids of the transcript lines it is based on, written as ⟦s12⟧ or ⟦s12,s13⟧. Put ids nowhere else.'

export function sectionUserPrompt(text: string, index: number, total: number, range: string, tags: boolean): string {
  const head = total > 1
    ? `This is part ${index + 1} of ${total} (${range}) of a recording transcript. Outline ONLY this part, following the output rules. Use "# " for a short title of this part.`
    : 'This is a recording transcript. Outline it, following the output rules.'
  return `${head}${tags ? `\n\n${SOURCE_RULE}` : ''}\n\n---\n\n${text}`
}

export function transcriptMergePrompt(outlines: string[], tags: boolean): string {
  const keep = tags ? '\n\nThe lines end with source markers like ⟦s12⟧. Keep them: every line of the merged outline must end with the markers of the lines it came from (combine them when you merge lines, e.g. ⟦s3,s40⟧).' : ''
  return mergeUserPrompt(outlines).replace('\n\n', `${keep}\n\n`)
}

export const INCREMENTAL_SYSTEM_PROMPT = `You keep a live mind map up to date while a recording is going on. You get the map's current branches and the newest transcript lines. Output ONLY a nested Markdown bullet list ("- " items, 2 spaces of indent per level) with the NEW information:
1. Top-level items are branches. To add under an existing branch, repeat its text exactly as given. Otherwise start a new, short branch.
2. Under them, write the new points as short key phrases, at most 2 more levels.
3. Do not repeat points that are already in the map. Do not rewrite, rename or remove anything.
4. If the new lines contain nothing worth adding, output exactly: NONE
5. Write in the language of the transcript. No headings, no preface, no explanation, no code fences.`

export function incrementalUserPrompt(title: string, branches: string, text: string, tags: boolean): string {
  return [
    `Mind map title: ${title}`,
    `Current branches:\n${branches || '(the map is empty)'}`,
    tags ? SOURCE_RULE : '',
    `New transcript lines:\n${text}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
