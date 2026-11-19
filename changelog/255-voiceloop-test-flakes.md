## Fixed · #255 · The voice end-to-end test no longer fails by chance, so `npm run test:full` can be trusted again for voice work

`voiceLoop.test.ts` failed about once in five runs on a quiet machine, never because barge-in missed a stop word (0 misses in
~75 runs, cut after 150–700 ms). The failures were exact-transcript assertions on real speech models that read the same audio differently from run to run: Supertonic renders « Yes, Master? » with new noise
each time and Whisper wrote « Yesta. » or « Yes, Moss. » (3 of 40 syntheses), « Yeter. Y » / « Hayyuz. Hayy » after a
stop word, and « kartaş » for « kart aç ».

The Turkish command check now accepts both readings (« kart aç », « kartaş »), the sleep loop became the kit's
`eventually`, and the echo test takes a new synthesis only when Whisper heard something the loop is not meant to drop
(« yes do it »). No retry hides a loop failure: a stop word followed by a cut-off fragment, or a misheard « Yes, Master? »
sent to the chat (both found here, fixed in #257), fails the test. The Tests how-to in CLAUDE.md says how to write voice tests.
