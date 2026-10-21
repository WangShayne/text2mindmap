# Test audio: sources and licenses

These files are **not** covered by the MIT license of text2mindmap. They are derived from public speech datasets and keep those datasets' licenses. All recordings are **real human speech** (no TTS).

## `zh-5min.m4a` + `zh-5min.ref.txt` (Mandarin, read speech, 5 min 05 s)

- Source: **FLEURS**, Mandarin Chinese (`cmn_hans_cn`), test split. Google, 2022. <https://huggingface.co/datasets/google/fleurs>
- License: **CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>)
- Paper: A. Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech", arXiv:2205.12446.
- Changes: 27 utterances (the first test sentences by sentence id whose text has no Latin letters or digits, one recording per sentence) were converted to 16 kHz mono, joined with 0.5 s of silence and encoded as AAC (64 kbit/s) in .m4a. The reference text is FLEURS' `raw_transcription` of those utterances, one per line. `zh-5min.sources.json` lists the utterance ids and files.

## `mix-50s.m4a` + `mix-50s.ref.txt` (Mandarin–English code-switching, conversational, 51 s)

- Source: **ASCEND** (A Spontaneous Chinese-English Dataset for Code-switching in Multi-turn Conversation), test split. HKUST CAiRE, 2022. <https://huggingface.co/datasets/CAiRE/ASCEND>
- License: **CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>). This derived clip is shared under the same license.
- Paper: H. Lovenia et al., "ASCEND: A Spontaneous Chinese-English Dataset for Code-switching in Multi-turn Conversation", LREC 2022.
- Changes: 11 utterances labelled `mixed` (≥ 2.5 s, no `[UNK]`) were converted to 16 kHz mono, joined with 0.5 s of silence and encoded as AAC (64 kbit/s). The reference is ASCEND's `transcription`. `mix-50s.sources.json` lists the utterance ids and files.

## Notes for CER

- References are written transcripts. FLEURS keeps punctuation and Chinese numerals; the bench ignores punctuation and spaces, but number formatting (e.g. 两 vs 2) and Traditional vs Simplified characters still count as errors.
- ASCEND transcripts are lowercase, with spelled-out acronyms ("i s m"); conversational fillers (呃, um) are part of the reference.
