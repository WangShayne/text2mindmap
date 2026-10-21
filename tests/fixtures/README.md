# Test fixtures

`sensevoice-realtime-events.json`: the `delta` / `completed` events sensevoice-server's
`/v1/realtime` produced for the first 24 s of a 5-minute clip of ASCEND mixed Chinese–English
test-split utterances (built the same way as `scripts/asr-bench/audio/mix-50s`, more utterances),
streamed at real-time pace in 100 ms frames.
The text is a machine transcript of ASCEND speech, so like the audio it is under CC BY-SA 4.0
(HKUST ASCEND), not the MIT License; see `scripts/asr-bench/DATA_LICENSE.md`.
