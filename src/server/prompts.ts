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
